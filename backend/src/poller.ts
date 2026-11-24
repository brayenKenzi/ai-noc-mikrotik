import { RouterOsClient, RouterOsSessionPool, type RouterOsCommandOutcome } from './routerosClient.js';
import { isRadiusTimeoutMessage, parseHotspotFailedLogin } from './syslogReceiver.js';
import { parseRouterOsPingRows, type PingThresholds } from './pingMonitor.js';
import { resolveRouterDutyProfile } from './linkWatchdog.js';
import { pollRouterSfpOptics } from './sfpMonitor.js';
import type {
  InterfaceMetric,
  PingMetric,
  RouterDevice,
  RouterHealthStatus,
  RouterTelemetry,
  SfpOpticalMetric,
  SyslogEntry,
} from './types.js';

interface CounterSample {
  readonly rxByte: number;
  readonly txByte: number;
  readonly timestampMs: number;
}

interface RouterPollCache {
  tick: number;
  temperatureC: number | null;
  voltageV: number | null;
  bgpPeersEstablished: number;
  bgpPeersTotal: number;
  sfpOptics: readonly SfpOpticalMetric[];
}

const interfaceCounterCache = new Map<string, CounterSample>();
const secondaryPollCache = new Map<string, RouterPollCache>();
export const sharedRouterOsPool = new RouterOsSessionPool();

export function computeHealthStatus(
  reachable: boolean,
  cpuLoadPercent: number,
  memoryUsedPercent: number,
  temperatureC: number | null,
): RouterHealthStatus {
  if (!reachable) return 'offline';
  if (cpuLoadPercent >= 90 || memoryUsedPercent >= 92 || (temperatureC !== null && temperatureC >= 75)) {
    return 'critical';
  }
  if (cpuLoadPercent >= 75 || memoryUsedPercent >= 82 || (temperatureC !== null && temperatureC >= 65)) {
    return 'warning';
  }
  return 'healthy';
}

export function parseSystemHealth(rows: readonly Record<string, string>[]): {
  readonly temperatureC: number | null;
  readonly voltageV: number | null;
} {
  let temperatureC: number | null = null;
  let voltageV: number | null = null;

  for (const row of rows) {
    const metricName = (row.name ?? '').toLowerCase();
    if (metricName && row.value !== undefined) {
      const parsedVal = Number.parseFloat(row.value);
      if (!Number.isNaN(parsedVal)) {
        if (metricName === 'temperature' || (metricName.includes('temperature') && temperatureC === null)) {
          temperatureC = parsedVal;
        } else if (metricName === 'voltage' && voltageV === null) {
          voltageV = parsedVal;
        }
      }
      continue;
    }

    const rawTemp = row.temperature ?? row['cpu-temperature'];
    if (rawTemp !== undefined && temperatureC === null) {
      const t = Number.parseFloat(rawTemp);
      if (!Number.isNaN(t)) temperatureC = t;
    }
    if (row.voltage !== undefined && voltageV === null) {
      const v = Number.parseFloat(row.voltage);
      if (!Number.isNaN(v)) voltageV = v;
    }
  }

  return { temperatureC, voltageV };
}

export function computeDeltaMbps(prevBytes: number, currentBytes: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || currentBytes < prevBytes) {
    return 0;
  }
  const deltaBits = (currentBytes - prevBytes) * 8;
  const mbps = deltaBits / (elapsedMs * 1000);
  return Number(Math.max(0, mbps).toFixed(2));
}

export function parsePppActiveCount(outcome: RouterOsCommandOutcome | undefined): number {
  if (!outcome || !outcome.ok) return 0;
  if (outcome.doneAttrs.ret !== undefined) {
    const parsed = Number.parseInt(outcome.doneAttrs.ret, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return outcome.rows.length;
}

export function parseBgpPeerStats(outcome: RouterOsCommandOutcome | undefined): {
  readonly established: number;
  readonly total: number;
} {
  if (!outcome || !outcome.ok) return { established: 0, total: 0 };
  const total = outcome.rows.length;
  const established = outcome.rows.filter(
    (row) => row.established === 'true' || (row.state ?? '').toLowerCase() === 'established',
  ).length;
  return { established, total };
}

export function isDynamicSubscriberInterface(row: Readonly<Record<string, string>>): boolean {
  if (row.dynamic === 'true') return true;
  const name = (row.name ?? '').toLowerCase();
  return (
    name.startsWith('<pppoe-') ||
    name.startsWith('<pptp-') ||
    name.startsWith('<l2tp-') ||
    name.startsWith('<ovpn-') ||
    name.startsWith('<sstp-')
  );
}

export function sortInterfaces(list: readonly InterfaceMetric[]): InterfaceMetric[] {
  return [...list].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
    const bwDiff = b.rxMbps + b.txMbps - (a.rxMbps + a.txMbps);
    if (Math.abs(bwDiff) > 0.05) return bwDiff;
    const aSfp = a.name.toLowerCase().includes('sfp') ? 0 : 1;
    const bSfp = b.name.toLowerCase().includes('sfp') ? 0 : 1;
    if (aSfp !== bSfp) return aSfp - bSfp;
    return a.name.localeCompare(b.name);
  });
}

export function parseRouterApiLogs(
  router: RouterDevice,
  rows: readonly Record<string, string>[],
): readonly SyslogEntry[] {
  const selfUser = router.readUsername.toLowerCase();
  const recentRows = rows
    .filter((row) => {
      const msg = (row.message ?? '').trim();
      if (!msg) return false;
      const lower = msg.toLowerCase();
      if (lower.includes(`user ${selfUser} logged`) && lower.includes('via api')) {
        return false;
      }
      return true;
    })
    .slice(-60)
    .reverse();
  const nowIso = new Date().toISOString();

  return recentRows.map((row) => {
    const message = (row.message ?? '').trim();
    const rawTopics = (row.topics ?? 'system').toLowerCase().split(',').filter(Boolean);
    const topics = rawTopics.length > 0 ? rawTopics : ['system'];
    let severity: SyslogEntry['severity'] = 'info';
    if (isRadiusTimeoutMessage(message) || rawTopics.includes('critical')) {
      severity = 'critical';
    } else if (rawTopics.includes('error') || parseHotspotFailedLogin({ topics, message }) !== null) {
      severity = 'error';
    } else if (rawTopics.includes('warning')) {
      severity = 'warning';
    }

    const idKey = row['.id'] ?? '';
    const timeKey = row.time ?? '';
    return {
      id: `api:${router.id}:${idKey}:${timeKey}:${message.slice(0, 48)}`,
      routerId: router.id,
      sourceIp: router.host,
      timestamp: nowIso,
      topics,
      severity,
      message: timeKey ? `[${timeKey}] ${message}` : message,
    };
  });
}

export interface RouterPollResult {
  readonly telemetry: RouterTelemetry;
  readonly apiLogs: readonly SyslogEntry[];
}

export async function pollRouterTelemetry(
  router: RouterDevice,
  forceLive = false,
  resolvedSecret?: string,
): Promise<RouterTelemetry> {
  const res = await pollRouterWithLogs(router, forceLive, resolvedSecret, forceLive);
  return res.telemetry;
}

export async function pollRouterWithLogs(
  router: RouterDevice,
  forceLive = false,
  resolvedSecret?: string,
  oneShotTest = false,
): Promise<RouterPollResult> {
  if (router.simulated && !forceLive) {
    return { telemetry: generateSimulatedTelemetry(router), apiLogs: [] };
  }

  const secret =
    (resolvedSecret !== undefined && resolvedSecret !== '' ? resolvedSecret : process.env[router.readSecretEnv]) ?? '';
  if (!secret) {
    return {
      telemetry: {
        routerId: router.id,
        timestamp: new Date().toISOString(),
        reachable: false,
        uptime: '-',
        version: router.routerOsVersion,
        boardName: router.deviceModel ?? 'MikroTik',
        cpuLoadPercent: 0,
        memoryUsedPercent: 0,
        temperatureC: null,
        voltageV: null,
        activePppoeCount: 0,
        activeHotspotCount: 0,
        hotspotHostCount: 0,
        dhcpLeaseCount: 0,
        bgpPeersEstablished: 0,
        bgpPeersTotal: 0,
        interfaces: [],
        status: 'offline',
        lastError: `Password MikroTik belum diisi di GUI maupun ${router.readSecretEnv}`,
      },
      apiLogs: [],
    };
  }

  const connOpts = {
    host: router.host,
    port: router.port,
    useTls: router.useTls,
    username: router.readUsername,
    secret,
    timeoutMs: 5000,
  };

  const prevCache = secondaryPollCache.get(router.id);
  const tick = (prevCache?.tick ?? 0) + 1;
  // Pull heavier health/BGP/log queries on first poll, one-shot test, or every 3rd fast tick (~9s)
  const includeSecondary = oneShotTest || !prevCache || tick % 3 === 1;

  try {
    const bgpCommand =
      router.routerOsVersion === 'v7' ? ['/routing/bgp/session/print'] : ['/routing/bgp/peer/print'];
    const commands: string[][] = [
      ['/system/resource/print'],
      ['/interface/print'],
      ['/ppp/active/print', '=count-only='],
      ['/ip/hotspot/active/print', '=count-only='],
      ['/ip/hotspot/host/print', '=count-only='],
      ['/ip/dhcp-server/lease/print', '=count-only='],
    ];
    if (includeSecondary) {
      commands.push(['/system/health/print'], bgpCommand, ['/log/print']);
    }

    const outcomes = oneShotTest
      ? await new RouterOsClient(connOpts).connectAndRunTolerant(commands)
      : await sharedRouterOsPool.runTolerant(router.id, connOpts, commands);

    const [resOut, ifaceOut, pppOut, hsActiveOut, hsHostOut, dhcpOut, healthOut, bgpOut, logOut] = outcomes;

    const res = resOut?.ok ? (resOut.rows[0] ?? {}) : {};
    const cpuLoadPercent = Number(res['cpu-load'] ?? '0');
    const totalMem = Number(res['total-memory'] ?? '1');
    const freeMem = Number(res['free-memory'] ?? '0');
    const memoryUsedPercent = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0;

    const nowMs = Date.now();
    const rawInterfaces: InterfaceMetric[] = (ifaceOut?.ok ? ifaceOut.rows : [])
      .filter((row) => !isDynamicSubscriberInterface(row))
      .map((row) => {
        const name = row.name ?? 'ether';
        const rxByte = Number(row['rx-byte'] ?? '0');
        const txByte = Number(row['tx-byte'] ?? '0');
        const cacheKey = `${router.id}:${name}`;
        const prev = interfaceCounterCache.get(cacheKey);
        const rxMbps = prev ? computeDeltaMbps(prev.rxByte, rxByte, nowMs - prev.timestampMs) : 0;
        const txMbps = prev ? computeDeltaMbps(prev.txByte, txByte, nowMs - prev.timestampMs) : 0;
        interfaceCounterCache.set(cacheKey, { rxByte, txByte, timestampMs: nowMs });

        return {
          name,
          running: row.running === 'true',
          disabled: row.disabled === 'true',
          rxMbps,
          txMbps,
        };
      });
    const dutyProfile = resolveRouterDutyProfile(router);
    const watchedSet = new Set(dutyProfile.watchedInterfaces.map((n) => n.toLowerCase()));
    const sortedAll = sortInterfaces(rawInterfaces);
    const watchedFirst = sortedAll.filter((i) => watchedSet.has(i.name.toLowerCase()));
    const restIfaces = sortedAll.filter((i) => !watchedSet.has(i.name.toLowerCase()));
    const interfaces = [...watchedFirst, ...restIfaces].slice(0, Math.max(28, watchedFirst.length + 20));

    const activePppoeCount = parsePppActiveCount(pppOut);
    const activeHotspotCount = parsePppActiveCount(hsActiveOut);
    const hotspotHostCount = parsePppActiveCount(hsHostOut);
    const dhcpLeaseCount = parsePppActiveCount(dhcpOut);

    let temperatureC = prevCache?.temperatureC ?? null;
    let voltageV = prevCache?.voltageV ?? null;
    let bgpPeersEstablished = prevCache?.bgpPeersEstablished ?? 0;
    let bgpPeersTotal = prevCache?.bgpPeersTotal ?? 0;
    let sfpOptics: readonly SfpOpticalMetric[] = prevCache?.sfpOptics ?? [];

    if (includeSecondary) {
      const health = parseSystemHealth(healthOut?.ok ? healthOut.rows : []);
      temperatureC = health.temperatureC;
      voltageV = health.voltageV;
      const bgp = parseBgpPeerStats(bgpOut);
      bgpPeersEstablished = bgp.established;
      bgpPeersTotal = bgp.total;
    }

    // Poll SFP optical RX/TX dBm on first poll and every 10th tick (~30s) via persistent session
    const includeSfp = !oneShotTest && (!prevCache || tick % 10 === 1);
    if (includeSfp) {
      try {
        sfpOptics = await pollRouterSfpOptics(sharedRouterOsPool, router, connOpts, rawInterfaces);
      } catch {
        // Keep previous cached SFP readings if monitor command fails transiently
      }
    }

    secondaryPollCache.set(router.id, {
      tick,
      temperatureC,
      voltageV,
      bgpPeersEstablished,
      bgpPeersTotal,
      sfpOptics,
    });

    const apiLogs = includeSecondary && logOut?.ok ? parseRouterApiLogs(router, logOut.rows) : [];

    return {
      telemetry: {
        routerId: router.id,
        timestamp: new Date(nowMs).toISOString(),
        reachable: true,
        uptime: res.uptime ?? '0s',
        version: res.version ?? router.routerOsVersion,
        boardName: res['board-name'] ?? router.deviceModel ?? 'MikroTik',
        cpuLoadPercent,
        memoryUsedPercent,
        temperatureC,
        voltageV,
        activePppoeCount,
        activeHotspotCount,
        hotspotHostCount,
        dhcpLeaseCount,
        bgpPeersEstablished,
        bgpPeersTotal,
        interfaces,
        sfpOptics,
        status: computeHealthStatus(true, cpuLoadPercent, memoryUsedPercent, temperatureC),
      },
      apiLogs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tidak dapat terhubung ke RouterOS API';
    return {
      telemetry: {
        routerId: router.id,
        timestamp: new Date().toISOString(),
        reachable: false,
        uptime: 'down',
        version: router.routerOsVersion,
        boardName: router.deviceModel ?? 'Unreachable',
        cpuLoadPercent: 0,
        memoryUsedPercent: 0,
        temperatureC: null,
        voltageV: null,
        activePppoeCount: 0,
        activeHotspotCount: 0,
        hotspotHostCount: 0,
        dhcpLeaseCount: 0,
        bgpPeersEstablished: 0,
        bgpPeersTotal: 0,
        interfaces: [],
        status: 'offline',
        lastError: message,
      },
      apiLogs: [],
    };
  }
}

/**
 * Executes an ICMP ping FROM INSIDE the MikroTik router out through a specific interface
 * (e.g., CORE MONGKONAI `/ping address=1.1.1.1 interface=vlan2000-CMK count=4`)
 * using the existing persistent 1x-login session pool (zero repeated logins!).
 */
export async function pollRouterInterfacePing(
  router: RouterDevice,
  resolvedSecret: string | undefined,
  thresholds: PingThresholds,
): Promise<PingMetric | null> {
  if (router.simulated) return null;
  const profile = resolveRouterDutyProfile(router);
  const cfg = profile.interfacePing;
  if (!cfg || !cfg.interfaceName.trim() || !cfg.target.trim()) return null;

  // Validate interface & target defensively before sending to RouterOS API
  if (!/^[a-zA-Z0-9._:/\s-]+$/.test(cfg.interfaceName) || !/^[a-zA-Z0-9._:-]+$/.test(cfg.target)) {
    return null;
  }

  const secret =
    (resolvedSecret !== undefined && resolvedSecret !== '' ? resolvedSecret : process.env[router.readSecretEnv]) ?? '';
  if (!secret) return null;

  const connOpts = {
    host: router.host,
    port: router.port,
    useTls: router.useTls,
    username: router.readUsername,
    secret,
    timeoutMs: 9000,
  };

  const label = `${cfg.interfaceName} → ${cfg.target}`;
  const effectiveThresholds: PingThresholds = {
    warnMs: cfg.warnMs ?? thresholds.warnMs,
    critMs: cfg.critMs ?? thresholds.critMs,
    lossCritPct: thresholds.lossCritPct,
  };

  try {
    const [outcome] = await sharedRouterOsPool.runTolerant(router.id, connOpts, [
      ['/ping', `=address=${cfg.target.trim()}`, `=interface=${cfg.interfaceName.trim()}`, '=count=4'],
    ]);
    if (!outcome || !outcome.ok) {
      return {
        target: cfg.target,
        label,
        minMs: null,
        avgMs: null,
        maxMs: null,
        packetLossPercent: 100,
        status: 'down',
        updatedAt: new Date().toISOString(),
      };
    }
    return parseRouterOsPingRows(outcome.rows, cfg.target, label, effectiveThresholds);
  } catch {
    return {
      target: cfg.target,
      label,
      minMs: null,
      avgMs: null,
      maxMs: null,
      packetLossPercent: 100,
      status: 'down',
      updatedAt: new Date().toISOString(),
    };
  }
}

function generateSimulatedTelemetry(router: RouterDevice): RouterTelemetry {
  const wave = Math.sin(Date.now() / 20000 + router.deskX + router.deskZ);
  const baseCpu = router.role === 'bras' ? 38 : router.role === 'core' ? 22 : 26;
  const cpuLoadPercent = Math.max(5, Math.min(95, Math.round(baseCpu + wave * 10)));
  const memoryUsedPercent = router.role === 'bras' ? 52 : router.role === 'core' ? 31 : 44;
  const temperatureC = router.role === 'bras' ? 48 : router.role === 'core' ? 43 : 39;

  const isCrs = router.name.toLowerCase().includes('crs');
  const isCcr = router.name.toLowerCase().includes('ccr');

  return {
    routerId: router.id,
    timestamp: new Date().toISOString(),
    reachable: true,
    uptime: '18d 06:42:10',
    version: router.routerOsVersion === 'v7' ? '7.18.2 (stable)' : '6.49.17 (long-term)',
    boardName: isCcr ? 'CCR2004-16G-2S+' : isCrs ? 'CRS326-24S+2Q+RM' : 'RB750Gr3',
    cpuLoadPercent,
    memoryUsedPercent,
    temperatureC,
    voltageV: isCrs ? 24.4 : isCcr ? 24.1 : 23.8,
    activePppoeCount: router.role === 'bras' ? 350 : router.role === 'branch' ? 52 : 0,
    activeHotspotCount: router.role === 'bras' ? 42 : router.role === 'branch' ? 14 : 0,
    hotspotHostCount: router.role === 'bras' ? 58 : router.role === 'branch' ? 19 : 0,
    dhcpLeaseCount: router.role === 'bras' ? 120 : router.role === 'branch' ? 35 : 0,
    bgpPeersEstablished: router.role === 'core' ? 2 : router.role === 'bras' ? 3 : 0,
    bgpPeersTotal: router.role === 'core' ? 2 : router.role === 'bras' ? 3 : 0,
    interfaces: isCrs
      ? [
          { name: 'sfp-sfpplus1-Uplink', running: true, disabled: false, rxMbps: 842.4, txMbps: 295.1 },
          { name: 'sfp-sfpplus2-Ring', running: true, disabled: false, rxMbps: 410.8, txMbps: 405.3 },
          { name: 'ether1-Mgmt', running: true, disabled: false, rxMbps: 4.2, txMbps: 2.1 },
        ]
      : isCcr
        ? [
            { name: 'ether1-UPLINK', running: true, disabled: false, rxMbps: 450.4, txMbps: 34.2 },
            { name: 'bridge-OLT', running: true, disabled: false, rxMbps: 26.5, txMbps: 342.6 },
            { name: 'ether1-Mgmt', running: true, disabled: false, rxMbps: 8.4, txMbps: 3.9 },
          ]
        : [
            { name: 'ether1-WAN-Backbone', running: true, disabled: false, rxMbps: 145.6, txMbps: 32.8 },
            { name: 'ether2-Client-PPPoE', running: true, disabled: false, rxMbps: 31.4, txMbps: 142.1 },
            { name: 'ether5-Hotspot', running: true, disabled: false, rxMbps: 12.1, txMbps: 28.4 },
          ],
    status: computeHealthStatus(true, cpuLoadPercent, memoryUsedPercent, temperatureC),
  };
}
