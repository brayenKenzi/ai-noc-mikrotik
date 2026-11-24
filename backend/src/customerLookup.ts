import type { RouterOsSessionPool } from './routerosClient.js';
import type {
  CustomerLookupResult,
  CustomerSessionMatch,
  RouterDevice,
  SyslogEntry,
} from './types.js';

const GENERIC_NON_CUSTOMER_WORDS = new Set([
  'semua',
  'all',
  'router',
  'jaringan',
  'trafik',
  'traffic',
  'ping',
  'topologi',
  'kabel',
  'memori',
  'memory',
  'sfp',
  'redaman',
  'optik',
  'rsc',
  'backup',
  'cpu',
  'ram',
  'kondisi',
  'status',
  'total',
  'hotspot',
  'pppoe',
]);

/**
 * Extracts a customer username/IP/MAC query from natural-language SPV chat if the admin asks e.g.:
 * - "/cek budi_01"
 * - "cek pelanggan budi"
 * - "cek user 10.10.20.5"
 * - "cari pelanggan budi"
 */
export function extractCustomerLookupQuery(message: string): string | null {
  const trimmed = message.trim();
  const slashMatch = trimmed.match(/^\/cek(?:@\S+)?\s+(.+)$/i);
  if (slashMatch?.[1]) {
    const q = slashMatch[1].trim().slice(0, 64);
    return q.length >= 2 ? q : null;
  }

  const nlMatch = trimmed.match(
    /^(?:spv(?:\s+noc)?[,:\s]+)?(?:tolong\s+)?(?:cek|cari|lacak|periksa)\s+(?:pelanggan|user|akun|client|klien|pppoe|hotspot)\s+["']?([a-zA-Z0-9._:@-]+)["']?$/i,
  );
  if (nlMatch?.[1]) {
    const candidate = nlMatch[1].trim();
    if (candidate.length >= 2 && !GENERIC_NON_CUSTOMER_WORDS.has(candidate.toLowerCase())) {
      return candidate.slice(0, 64);
    }
  }
  return null;
}

function bytesToMb(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round((n / (1024 * 1024)) * 10) / 10;
}

function bpsToMbps(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round((n / 1_000_000) * 100) / 100;
}

export function matchSessionRows(
  router: RouterDevice,
  pppRows: readonly Record<string, string>[],
  hsRows: readonly Record<string, string>[],
  query: string,
): CustomerSessionMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  const matches: CustomerSessionMatch[] = [];

  for (const row of pppRows) {
    const username = row.name ?? '';
    const address = row.address ?? '';
    const callerId = row['caller-id'] ?? '';
    if (
      username.toLowerCase().includes(needle) ||
      address.toLowerCase().includes(needle) ||
      callerId.toLowerCase().includes(needle)
    ) {
      matches.push({
        type: 'pppoe',
        routerId: router.id,
        routerName: router.name,
        username,
        address: address || '-',
        macOrCallerId: callerId || '-',
        uptime: row.uptime ?? '-',
        serviceOrServer: row.service ?? 'pppoe',
        rxMbps: null,
        txMbps: null,
        totalRxMb: null,
        totalTxMb: null,
        viaRadius: row.radius === 'true',
      });
    }
  }

  for (const row of hsRows) {
    const username = row.user ?? '';
    const address = row.address ?? '';
    const mac = row['mac-address'] ?? '';
    if (
      username.toLowerCase().includes(needle) ||
      address.toLowerCase().includes(needle) ||
      mac.toLowerCase().includes(needle)
    ) {
      matches.push({
        type: 'hotspot',
        routerId: router.id,
        routerName: router.name,
        username,
        address: address || '-',
        macOrCallerId: mac || '-',
        uptime: row.uptime ?? '-',
        serviceOrServer: row.server ?? 'hotspot',
        rxMbps: null,
        txMbps: null,
        totalRxMb: bytesToMb(row['bytes-in']),
        totalTxMb: bytesToMb(row['bytes-out']),
        viaRadius: row.radius === 'true',
      });
    }
  }

  return matches;
}

export async function searchCustomersAcrossFleet(params: {
  readonly query: string;
  readonly routers: readonly RouterDevice[];
  readonly resolveSecret: (router: RouterDevice) => string;
  readonly pool: RouterOsSessionPool;
  readonly logsByRouter: ReadonlyMap<string, readonly SyslogEntry[]>;
  readonly reachableRouterIds?: ReadonlySet<string>;
}): Promise<CustomerLookupResult> {
  const cleanQuery = params.query.trim().slice(0, 64);
  const needle = cleanQuery.toLowerCase();
  if (needle.length < 2) {
    return {
      query: cleanQuery,
      searchedRouters: 0,
      matches: [],
      relatedLogs: [],
      checkedAt: new Date().toISOString(),
    };
  }

  const liveRouters = params.routers.filter(
    (r) => !r.simulated && (!params.reachableRouterIds || params.reachableRouterIds.has(r.id)),
  );

  const perRouterMatches = await Promise.all(
    liveRouters.map(async (router): Promise<CustomerSessionMatch[]> => {
      const secret = params.resolveSecret(router);
      if (!secret) return [];
      const connOpts = {
        host: router.host,
        port: router.port,
        useTls: router.useTls,
        username: router.readUsername,
        secret,
        timeoutMs: 4500,
      };
      try {
        const [pppOut, hsOut] = await params.pool.runTolerant(router.id, connOpts, [
          ['/ppp/active/print'],
          ['/ip/hotspot/active/print'],
        ]);
        const baseMatches = matchSessionRows(
          router,
          pppOut?.ok ? pppOut.rows : [],
          hsOut?.ok ? hsOut.rows : [],
          cleanQuery,
        ).slice(0, 8);

        // Enrich matched PPPoE sessions with live traffic rate & total MB from dynamic <pppoe-user> interface
        const pppMatches = baseMatches.filter((m) => m.type === 'pppoe' && m.username);
        if (pppMatches.length > 0) {
          const enrichCmds: string[][] = [];
          for (const m of pppMatches) {
            const dynIf = `<pppoe-${m.username}>`;
            enrichCmds.push(['/interface/monitor-traffic', `=interface=${dynIf}`, '=once=']);
            enrichCmds.push(['/interface/print', `?name=${dynIf}`]);
          }
          const enrichOut = await params.pool.runTolerant(router.id, { ...connOpts, timeoutMs: 3000 }, enrichCmds);
          const enrichedMap = new Map<string, Partial<CustomerSessionMatch>>();
          pppMatches.forEach((m, idx) => {
            const monRow = enrichOut[idx * 2]?.ok ? enrichOut[idx * 2]?.rows[0] : undefined;
            const ifRow = enrichOut[idx * 2 + 1]?.ok ? enrichOut[idx * 2 + 1]?.rows[0] : undefined;
            // RouterOS <pppoe-user> TX = download to customer, RX = upload from customer
            enrichedMap.set(m.username, {
              rxMbps: bpsToMbps(monRow?.['rx-bits-per-second']),
              txMbps: bpsToMbps(monRow?.['tx-bits-per-second']),
              totalRxMb: bytesToMb(ifRow?.['rx-byte']),
              totalTxMb: bytesToMb(ifRow?.['tx-byte']),
            });
          });
          return baseMatches.map((m) =>
            m.type === 'pppoe' && enrichedMap.has(m.username) ? { ...m, ...enrichedMap.get(m.username) } : m,
          );
        }

        return baseMatches;
      } catch {
        return [];
      }
    }),
  );

  const allMatches = perRouterMatches.flat().slice(0, 15);

  const relatedLogs: SyslogEntry[] = [];
  for (const router of params.routers) {
    const rLogs = params.logsByRouter.get(router.id) ?? [];
    for (const lg of rLogs) {
      if (lg.message.toLowerCase().includes(needle)) {
        relatedLogs.push(lg);
      }
    }
  }
  relatedLogs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    query: cleanQuery,
    searchedRouters: liveRouters.length,
    matches: allMatches,
    relatedLogs: relatedLogs.slice(0, 8),
    checkedAt: new Date().toISOString(),
  };
}

export function formatCustomerLookupPlainText(res: CustomerLookupResult): string {
  const lines: string[] = [
    `HASIL CEK PELANGGAN SPV NOC: "${res.query}"`,
    `Router Live Diperiksa: ${res.searchedRouters} perangkat`,
    '',
  ];

  if (res.matches.length === 0) {
    lines.push('STATUS: TIDAK DITEMUKAN ONLINE SAAT INI');
    lines.push('Pelanggan sedang offline, salah ketik nama/IP/MAC, atau sesi belum tersambung.');
  } else {
    lines.push(`STATUS: DITEMUKAN ${res.matches.length} SESI AKTIF (ONLINE)`);
    for (const m of res.matches) {
      const rateTxt =
        m.txMbps !== null || m.rxMbps !== null
          ? ` · Trafik Live DL ${m.txMbps ?? 0} Mbps / UL ${m.rxMbps ?? 0} Mbps`
          : '';
      const quotaTxt =
        m.totalTxMb !== null || m.totalRxMb !== null
          ? ` · Pemakaian DL ${m.totalTxMb ?? 0} MB / UL ${m.totalRxMb ?? 0} MB`
          : '';
      lines.push(
        `• [${m.type.toUpperCase()}] ${m.username} @ ${m.routerName}`,
        `  IP: ${m.address} · MAC/Caller: ${m.macOrCallerId} · Uptime: ${m.uptime}${m.viaRadius ? ' · RADIUS' : ''}${rateTxt}${quotaTxt}`,
      );
    }
  }

  if (res.relatedLogs.length > 0) {
    lines.push('', `RIWAYAT LOG TERKAIT (${res.relatedLogs.length} TERBARU):`);
    for (const lg of res.relatedLogs.slice(0, 5)) {
      lines.push(`• [${lg.routerId}] ${lg.message}`);
    }
  }

  return lines.join('\n');
}
