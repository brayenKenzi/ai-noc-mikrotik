import crypto from 'node:crypto';
import type { NmsAlarmItem, NmsClient, NmsOltItem, NmsOnuSearchMatch } from './nmsClient.js';

export interface NmsPendingAction {
  readonly id: string;
  readonly actionType: 'reboot_modem' | 'ubah_wifi_pelanggan';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly requestedBy: string;
  readonly target: {
    readonly oltName: string;
    readonly oltHost: string;
    readonly index: string;
    readonly mac: string;
    readonly onuName: string;
    readonly pppoeUsername?: string;
  };
  readonly verifyResult?: Record<string, unknown>;
  readonly wifiParams?: {
    readonly ssid?: string;
    readonly password?: string;
  };
  readonly summary: string;
}

export interface NmsCustomerLookupItem {
  readonly oltName: string;
  readonly oltHost: string;
  readonly index: string;
  readonly name: string;
  readonly mac: string;
  readonly status: string;
  readonly rxDbm: number | null;
  readonly rxDrop: boolean;
  readonly pppoeUsername: string | null;
  readonly pppoeIp: string | null;
  readonly pppoeUptime: string | null;
  readonly txMbps: number | null;
  readonly rxMbps: number | null;
  readonly txGb: number | null;
  readonly rxGb: number | null;
  readonly routerName: string | null;
  readonly genieacs?: Record<string, unknown> | null;
}

export interface NmsNetworkHealthSummary {
  readonly configured: boolean;
  readonly oltsTotal: number;
  readonly oltsReachable: number;
  readonly totalOnus: number;
  readonly onlineOnus: number;
  readonly offlineOnus: number;
  readonly activeAlarmsCount: number;
  readonly olts: readonly {
    readonly name: string;
    readonly host: string;
    readonly liveOk: boolean;
    readonly error: string | null;
    readonly totalOnus: number;
    readonly onlineOnus: number;
    readonly offlineOnus: number;
  }[];
  readonly activeAlarms: readonly NmsAlarmItem[];
  readonly recentResolvedAlarms: readonly NmsAlarmItem[];
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100) / 100;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.round(n * 100) / 100;
  }
  return null;
}

function bpsToMbps(v: unknown): number | null {
  const n = toNum(v);
  if (n === null || n < 0) return null;
  return Math.round((n / 1_000_000) * 100) / 100;
}

function pickGenieAcsFields(raw: Record<string, unknown> | null | undefined): {
  readonly ssid: string | null;
  readonly model: string | null;
  readonly serial: string | null;
  readonly devices: readonly { readonly hostName: string; readonly ip: string; readonly mac: string; readonly rssi: string }[];
} {
  if (!raw || typeof raw !== 'object') {
    return { ssid: null, model: null, serial: null, devices: [] };
  }
  const dev = (raw.device && typeof raw.device === 'object' ? (raw.device as Record<string, unknown>) : raw);
  const wifi = (dev.wifi && typeof dev.wifi === 'object' ? (dev.wifi as Record<string, unknown>) : dev);
  const ssid =
    typeof wifi.ssid === 'string'
      ? wifi.ssid
      : typeof dev.ssid === 'string'
        ? dev.ssid
        : typeof raw.ssid === 'string'
          ? raw.ssid
          : null;
  const model =
    typeof dev.model === 'string'
      ? dev.model
      : typeof dev.productClass === 'string'
        ? dev.productClass
        : typeof raw.model === 'string'
          ? raw.model
          : null;
  const serial =
    typeof dev.serial === 'string'
      ? dev.serial
      : typeof dev.serialNumber === 'string'
        ? dev.serialNumber
        : typeof raw.serial === 'string'
          ? raw.serial
          : null;

  const rawClients =
    (Array.isArray(raw.clients) && raw.clients) ||
    (Array.isArray(raw.devices) && raw.devices) ||
    (Array.isArray(raw.hosts) && raw.hosts) ||
    (Array.isArray(dev.clients) && dev.clients) ||
    (Array.isArray(dev.hosts) && dev.hosts) ||
    [];

  const devices = (rawClients as Record<string, unknown>[]).slice(0, 20).map((c) => ({
    hostName: String(c.hostname ?? c.hostName ?? c.name ?? '-'),
    ip: String(c.ip ?? c.ipAddress ?? c.address ?? '-'),
    mac: String(c.mac ?? c.macAddress ?? '-'),
    rssi: c.rssi !== undefined && c.rssi !== null ? `${c.rssi} dBm` : '-',
  }));

  return { ssid, model, serial, devices };
}

/**
 * AI Tool Suite for ADT Monitoring NMS:
 * - Read-Only Tools: `cek_pelanggan`, `cek_gangguan_jaringan`, `cek_perangkat_wifi`
 * - Human-Confirmed Write Tools: `reboot_modem`, `ubah_wifi_pelanggan`
 */
export class NmsToolSuite {
  private readonly client: NmsClient;
  private readonly pendingActions = new Map<string, NmsPendingAction>();
  private readonly pendingTtlMs = 5 * 60 * 1000; // 5 minutes

  constructor(client: NmsClient) {
    this.client = client;
  }

  get isConfigured(): boolean {
    return this.client.isConfigured;
  }

  listPendingActions(): readonly NmsPendingAction[] {
    this.pruneExpiredActions();
    return Array.from(this.pendingActions.values());
  }

  async refreshOlts(host?: string): Promise<Record<string, unknown>> {
    return this.client.refreshOlt(host);
  }

  async getOnuDetail(
    host: string,
    mac: string,
    index: string,
    days: 'hour' | '1' | '7' = '7',
  ): Promise<Record<string, unknown>> {
    return this.client.getOnuDetail(host, mac, index, days);
  }

  private pruneExpiredActions(): void {
    const now = Date.now();
    for (const [id, act] of this.pendingActions.entries()) {
      if (new Date(act.expiresAt).getTime() <= now) {
        this.pendingActions.delete(id);
      }
    }
  }

  /**
   * Tool 1 (Read-Only): `cek_pelanggan(query)`
   * Searches OLT ONU by name, PPPoE username, MAC, or IP + attaches cached GenieACS modem summary.
   */
  async cekPelanggan(query: string): Promise<{
    readonly items: readonly NmsCustomerLookupItem[];
    readonly formattedText: string;
  }> {
    const matches = (await this.client.searchOnus(query)).slice(0, 6);
    if (matches.length === 0) {
      return {
        items: [],
        formattedText: [
          `CEK PELANGGAN OLT & MODEM: "${query}"`,
          `━━━━━━━━━━━━━━━━━━━━━━━━`,
          `Tidak ditemukan ONU/pelanggan yang cocok di seluruh OLT ADT Monitoring.`,
        ].join('\n'),
      };
    }

    const items: NmsCustomerLookupItem[] = await Promise.all(
      matches.map(async (m, idx): Promise<NmsCustomerLookupItem> => {
        let genieacs: Record<string, unknown> | null = null;
        // Fast cached GenieACS lookup (summon=0) for top 2 matches so response stays snappy
        if (idx < 2 && m.onu.mac) {
          try {
            genieacs = await this.client.getGenieAcsDevice(m.oltHost, m.onu.mac, m.onu.index, 0, 0);
          } catch {
            genieacs = null;
          }
        }
        return {
          oltName: m.oltName,
          oltHost: m.oltHost,
          index: m.onu.index,
          name: m.onu.name,
          mac: m.onu.mac,
          status: m.onu.status,
          rxDbm: toNum(m.onu.rx),
          rxDrop: Boolean(m.onu.rxDrop),
          pppoeUsername: m.onu.pppoe?.username ?? null,
          pppoeIp: m.onu.pppoe?.address ?? m.onu.pppoe?.ip ?? null,
          pppoeUptime: m.onu.pppoe?.uptime ?? null,
          txMbps: bpsToMbps(m.onu.pppoe?.txBps),
          rxMbps: bpsToMbps(m.onu.pppoe?.rxBps),
          txGb: toNum(m.onu.pppoe?.txGB),
          rxGb: toNum(m.onu.pppoe?.rxGB),
          routerName: m.onu.pppoe?.routerName ?? null,
          genieacs,
        };
      }),
    );

    const lines: string[] = [
      `HASIL CEK PELANGGAN OLT & MODEM: "${query}"`,
      `━━━━━━━━━━━━━━━━━━━━━━━━`,
      `Ditemukan ${items.length} ONU di ADT Monitoring NMS:`,
      ``,
    ];

    for (const it of items) {
      const rxTxt =
        it.rxDbm !== null ? `${it.rxDbm} dBm${it.rxDrop ? ' [REDAMAN DROP]' : ''}` : '-';
      const g = pickGenieAcsFields(it.genieacs);
      lines.push(
        `• ${it.name || it.pppoeUsername || it.mac} [${it.status.toUpperCase()}]`,
        `  OLT / Port : ${it.oltName} (${it.oltHost}) · Index ${it.index}`,
        `  MAC / RX   : ${it.mac} · Redaman RX ${rxTxt}`,
      );
      if (it.pppoeUsername) {
        lines.push(
          `  PPPoE      : ${it.pppoeUsername} · IP ${it.pppoeIp ?? '-'} · Uptime ${it.pppoeUptime ?? '-'}${it.routerName ? ` (${it.routerName})` : ''}`,
        );
        if (it.txMbps !== null || it.rxMbps !== null) {
          lines.push(
            `  Trafik     : DL ${it.txMbps ?? 0} Mbps / UL ${it.rxMbps ?? 0} Mbps${it.txGb !== null ? ` · Total ${it.txGb} GB DL / ${it.rxGb ?? 0} GB UL` : ''}`,
          );
        }
      }
      if (g.ssid || g.model || g.devices.length > 0) {
        lines.push(
          `  Modem WiFi : ${g.model ?? 'GenieACS'}${g.ssid ? ` · SSID "${g.ssid}"` : ''} · ${g.devices.length} perangkat tersambung`,
        );
      }
    }

    return { items, formattedText: lines.join('\n') };
  }

  /**
   * Tool 2 (Read-Only): `cek_gangguan_jaringan()`
   * Summarizes active alarms from `GET /api/alarms` and OLT fleet health from `GET /api/olts`.
   */
  async cekGangguanJaringan(): Promise<{
    readonly summary: NmsNetworkHealthSummary;
    readonly formattedText: string;
  }> {
    const [olts, alarms] = await Promise.all([this.client.getOlts(), this.client.getAlarms()]);
    const activeAlarms = alarms.filter((a) => a.until === null || a.until === undefined);
    const recentResolved = alarms.filter((a) => a.until !== null && a.until !== undefined).slice(0, 8);

    let totalOnus = 0;
    let onlineOnus = 0;
    let offlineOnus = 0;
    let oltsReachable = 0;

    const oltSummaries = olts.map((o: NmsOltItem) => {
      const rows = Array.isArray(o.rows) ? o.rows : [];
      const on = rows.filter((r) => (r.status ?? '').toLowerCase() === 'online').length;
      const off = rows.length - on;
      totalOnus += rows.length;
      onlineOnus += on;
      offlineOnus += off;
      const liveOk = Boolean(o.liveOk && !o.networkUnreachable);
      if (liveOk) oltsReachable += 1;
      return {
        name: o.name || o.host,
        host: o.host,
        liveOk,
        error: o.error ?? null,
        totalOnus: rows.length,
        onlineOnus: on,
        offlineOnus: off,
      };
    });

    const summary: NmsNetworkHealthSummary = {
      configured: this.client.isConfigured,
      oltsTotal: olts.length,
      oltsReachable,
      totalOnus,
      onlineOnus,
      offlineOnus,
      activeAlarmsCount: activeAlarms.length,
      olts: oltSummaries,
      activeAlarms: activeAlarms.slice(0, 25),
      recentResolvedAlarms: recentResolved,
    };

    const lines: string[] = [
      `LAPORAN GANGGUAN & OLT — ADT MONITORING NMS`,
      `━━━━━━━━━━━━━━━━━━━━━━━━`,
      `RINGKASAN OLT & ONU`,
      `• OLT Aktif    : ${oltsReachable}/${olts.length} OLT Terjangkau`,
      `• Total ONU    : ${onlineOnus} Online · ${offlineOnus} Offline (Total ${totalOnus})`,
      `• Alarm Aktif  : ${activeAlarms.length} gangguan berlangsung`,
      ``,
      `STATUS PER OLT`,
      ...oltSummaries.map(
        (o) =>
          `• ${o.name} (${o.host}): ${o.liveOk ? `ONLINE · ${o.onlineOnus} On / ${o.offlineOnus} Off` : `TIDAK TERJANGKAU (${o.error ?? 'Network Unreachable'})`}`,
      ),
    ];

    if (activeAlarms.length > 0) {
      lines.push(``, `ALARM JARINGAN AKTIF (${activeAlarms.length})`);
      for (const al of activeAlarms.slice(0, 12)) {
        lines.push(`• [${String(al.kind ?? 'ALARM').toUpperCase()}] ${al.title ?? al.key ?? 'Gangguan'}${al.detail ? ` — ${al.detail}` : ''}`);
      }
    } else {
      lines.push(``, `ALARM JARINGAN AKTIF`, `• Aman, tidak ada alarm OLT/PON/ONU aktif saat ini.`);
    }

    return { summary, formattedText: lines.join('\n') };
  }

  /**
   * Tool 3 (Read-Only): `cek_perangkat_wifi(query)`
   * Calls `GET /api/genieacs/device?summon=1&force=0` to retrieve live SSID and connected Wi-Fi devices.
   */
  async cekPerangkatWifi(query: string): Promise<{
    readonly match: NmsOnuSearchMatch | null;
    readonly genieacs: Record<string, unknown> | null;
    readonly parsed: ReturnType<typeof pickGenieAcsFields>;
    readonly formattedText: string;
  }> {
    const matches = await this.client.searchOnus(query);
    const match = matches[0] ?? null;
    if (!match) {
      return {
        match: null,
        genieacs: null,
        parsed: { ssid: null, model: null, serial: null, devices: [] },
        formattedText: `CEK PERANGKAT WIFI: Pelanggan "${query}" tidak ditemukan di data OLT ADT Monitoring.`,
      };
    }

    const genieacs = await this.client.getGenieAcsDevice(match.oltHost, match.onu.mac, match.onu.index, 1, 0);
    const parsed = pickGenieAcsFields(genieacs);

    const lines: string[] = [
      `CEK MODEM & PERANGKAT WIFI (GENIEACS)`,
      `━━━━━━━━━━━━━━━━━━━━━━━━`,
      `• Pelanggan  : ${match.onu.name || match.onu.pppoe?.username || match.onu.mac}`,
      `• OLT / Port : ${match.oltName} (${match.oltHost}) · Index ${match.onu.index}`,
      `• MAC ONU    : ${match.onu.mac} · Status ${match.onu.status}`,
      `• Model / SN : ${parsed.model ?? '-'} / ${parsed.serial ?? '-'}`,
      `• SSID WiFi  : ${parsed.ssid ?? '(tidak terbaca / modem belum terhubung TR-069)'}`,
      `• User Aktif : ${parsed.devices.length} perangkat tersambung`,
    ];

    if (parsed.devices.length > 0) {
      lines.push(``, `DAFTAR PERANGKAT TERSAMBUNG`);
      parsed.devices.forEach((d, idx) => {
        lines.push(`${idx + 1}. ${d.hostName} · IP ${d.ip} · MAC ${d.mac}${d.rssi !== '-' ? ` · RSSI ${d.rssi}` : ''}`);
      });
    }

    return { match, genieacs, parsed, formattedText: lines.join('\n') };
  }

  /**
   * Tool 4 (Guarded Write — Step 1): `reboot_modem(query)`
   * Runs `POST /api/onu/restart` with `action: "verify"` first, then waits for EXPLICIT operator confirmation!
   */
  async requestRebootModem(query: string, requestedBy = 'Operator NOC'): Promise<{
    readonly pendingAction: NmsPendingAction | null;
    readonly formattedText: string;
  }> {
    this.pruneExpiredActions();
    const matches = await this.client.searchOnus(query);
    if (matches.length === 0) {
      return {
        pendingAction: null,
        formattedText: `REBOOT MODEM DIBATALKAN: Pelanggan "${query}" tidak ditemukan di OLT.`,
      };
    }
    if (matches.length > 1) {
      const exact = matches.find(
        (m) =>
          (m.onu.pppoe?.username ?? '').toLowerCase() === query.trim().toLowerCase() ||
          (m.onu.mac ?? '').toLowerCase() === query.trim().toLowerCase() ||
          (m.onu.name ?? '').toLowerCase() === query.trim().toLowerCase(),
      );
      if (!exact) {
        return {
          pendingAction: null,
          formattedText: [
            `REBOOT MODEM BUTUH SPESIFIKASI LEBIH TEPAT (${matches.length} PELANGGAN COCOK):`,
            ...matches.slice(0, 5).map(
              (m) => `• ${m.onu.name || m.onu.pppoe?.username} | MAC ${m.onu.mac} | OLT ${m.oltName} (${m.onu.index})`,
            ),
            `Silakan ulangi dengan username PPPoE atau MAC persis agar tidak salah reboot pelanggan.`,
          ].join('\n'),
        };
      }
    }

    const target = matches[0]!;
    const verifyResult = await this.client.restartOnu(target.oltHost, target.onu.index, target.onu.mac, 'verify');

    const now = Date.now();
    const id = `NMS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const pendingAction: NmsPendingAction = {
      id,
      actionType: 'reboot_modem',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.pendingTtlMs).toISOString(),
      requestedBy,
      target: {
        oltName: target.oltName,
        oltHost: target.oltHost,
        index: target.onu.index,
        mac: target.onu.mac,
        onuName: target.onu.name || target.onu.pppoe?.username || target.onu.mac,
        ...(target.onu.pppoe?.username ? { pppoeUsername: target.onu.pppoe.username } : {}),
      },
      verifyResult,
      summary: `Reboot ONU ${target.onu.name || target.onu.mac} pada ${target.oltName} (${target.onu.index})`,
    };

    this.pendingActions.set(id, pendingAction);

    const formattedText = [
      `KONFIRMASI REBOOT MODEM / ONU (WAJIB PERSETUJUAN)`,
      `━━━━━━━━━━━━━━━━━━━━━━━━`,
      `• ID Aksi    : ${id} (berlaku 5 menit)`,
      `• Pelanggan  : ${pendingAction.target.onuName}`,
      `• OLT / Port : ${target.oltName} (${target.oltHost}) · Index ${target.onu.index}`,
      `• MAC ONU    : ${target.onu.mac}`,
      `• Verifikasi : Port & MAC sudah diverifikasi (action=verify OK)`,
      ``,
      `Modem BELUM di-reboot. Untuk mengeksekusi, konfirmasi dengan:`,
      `• Ketik /konfirmasi ${id} (atau klik tombol Konfirmasi di Dashboard Web)`,
      `• Ketik /batal ${id} untuk membatalkan.`,
    ].join('\n');

    return { pendingAction, formattedText };
  }

  /**
   * Tool 5 (Guarded Write — Step 1): `ubah_wifi_pelanggan(query, ssid, password)`
   * Validates SSID (<=32) & Password (8-63), then waits for EXPLICIT operator confirmation!
   */
  async requestUbahWifi(params: {
    readonly query: string;
    readonly ssid?: string;
    readonly password?: string;
    readonly requestedBy?: string;
  }): Promise<{
    readonly pendingAction: NmsPendingAction | null;
    readonly formattedText: string;
  }> {
    this.pruneExpiredActions();
    const cleanSsid = params.ssid !== undefined && params.ssid.trim() !== '' ? params.ssid.trim() : undefined;
    const cleanPass = params.password !== undefined && params.password !== '' ? params.password : undefined;

    if (!cleanSsid && !cleanPass) {
      throw new Error('Isi minimal SSID baru atau Password Wi-Fi baru.');
    }
    if (cleanSsid !== undefined && cleanSsid.length > 32) {
      throw new Error('SSID Wi-Fi maksimal 32 karakter.');
    }
    if (cleanPass !== undefined && (cleanPass.length < 8 || cleanPass.length > 63)) {
      throw new Error('Password Wi-Fi wajib 8 sampai 63 karakter.');
    }

    const matches = await this.client.searchOnus(params.query);
    if (matches.length === 0) {
      return {
        pendingAction: null,
        formattedText: `UBAH WIFI DIBATALKAN: Pelanggan "${params.query}" tidak ditemukan di OLT.`,
      };
    }

    const target = matches[0]!;
    const now = Date.now();
    const id = `WIFI-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const pendingAction: NmsPendingAction = {
      id,
      actionType: 'ubah_wifi_pelanggan',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.pendingTtlMs).toISOString(),
      requestedBy: params.requestedBy ?? 'Operator NOC',
      target: {
        oltName: target.oltName,
        oltHost: target.oltHost,
        index: target.onu.index,
        mac: target.onu.mac,
        onuName: target.onu.name || target.onu.pppoe?.username || target.onu.mac,
        ...(target.onu.pppoe?.username ? { pppoeUsername: target.onu.pppoe.username } : {}),
      },
      wifiParams: {
        ...(cleanSsid ? { ssid: cleanSsid } : {}),
        ...(cleanPass ? { password: cleanPass } : {}),
      },
      summary: `Ubah Wi-Fi modem ${target.onu.name || target.onu.mac}${cleanSsid ? ` (SSID: ${cleanSsid})` : ''}${cleanPass ? ' (Password baru)' : ''}`,
    };

    this.pendingActions.set(id, pendingAction);

    const formattedText = [
      `KONFIRMASI UBAH WIFI MODEM (GENIEACS — WAJIB PERSETUJUAN)`,
      `━━━━━━━━━━━━━━━━━━━━━━━━`,
      `• ID Aksi       : ${id} (berlaku 5 menit)`,
      `• Pelanggan     : ${pendingAction.target.onuName}`,
      `• OLT / MAC     : ${target.oltName} · ${target.onu.mac}`,
      `• SSID Baru     : ${cleanSsid ?? '(tidak diubah)'}`,
      `• Password Baru : ${cleanPass ? `Diubah (${cleanPass.length} karakter)` : '(tidak diubah)'}`,
      ``,
      `Wi-Fi BELUM diubah. Untuk mengeksekusi, konfirmasi dengan:`,
      `• Ketik /konfirmasi ${id} (atau klik tombol Konfirmasi di Dashboard Web)`,
      `• Ketik /batal ${id} untuk membatalkan.`,
    ].join('\n');

    return { pendingAction, formattedText };
  }

  /**
   * Step 2 (Explicit Operator Confirmation): executes the verified reboot or Wi-Fi update!
   */
  async confirmPendingAction(actionId: string, confirmedBy = 'Admin NOC'): Promise<{
    readonly ok: boolean;
    readonly action: NmsPendingAction | null;
    readonly result?: Record<string, unknown>;
    readonly formattedText: string;
  }> {
    this.pruneExpiredActions();
    const key = actionId.trim().toUpperCase();
    const action = this.pendingActions.get(key);
    if (!action) {
      return {
        ok: false,
        action: null,
        formattedText: `ID konfirmasi "${key}" tidak ditemukan atau sudah kedaluwarsa (> 5 menit).`,
      };
    }

    this.pendingActions.delete(key);

    if (action.actionType === 'reboot_modem') {
      const result = await this.client.restartOnu(
        action.target.oltHost,
        action.target.index,
        action.target.mac,
        'reboot',
      );
      return {
        ok: true,
        action,
        result,
        formattedText: [
          `REBOOT MODEM BERHASIL DIEKSEKUSI`,
          `━━━━━━━━━━━━━━━━━━━━━━━━`,
          `• Pelanggan  : ${action.target.onuName} (${action.target.mac})`,
          `• OLT / Port : ${action.target.oltName} · Index ${action.target.index}`,
          `• Disetujui  : ${confirmedBy}`,
          `• Status NMS : Perintah reboot terkirim ke OLT. Modem akan online kembali dalam 1-2 menit.`,
        ].join('\n'),
      };
    }

    const result = await this.client.updateGenieAcsWifi(
      action.target.oltHost,
      action.target.mac,
      action.target.index,
      action.wifiParams?.ssid,
      action.wifiParams?.password,
    );
    return {
      ok: true,
      action,
      result,
      formattedText: [
        `UBAH WIFI MODEM BERHASIL DIEKSEKUSI`,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
        `• Pelanggan  : ${action.target.onuName} (${action.target.mac})`,
        `• SSID Baru  : ${action.wifiParams?.ssid ?? '(tetap)'}`,
        `• Password   : ${action.wifiParams?.password ? 'Diperbarui' : '(tetap)'}`,
        `• Disetujui  : ${confirmedBy}`,
        `• Status NMS : Perubahan Wi-Fi berhasil dikirim via GenieACS TR-069.`,
      ].join('\n'),
    };
  }

  cancelPendingAction(actionId: string): { readonly ok: boolean; readonly formattedText: string } {
    this.pruneExpiredActions();
    const key = actionId.trim().toUpperCase();
    const existed = this.pendingActions.delete(key);
    return {
      ok: existed,
      formattedText: existed
        ? `Aksi ${key} telah dibatalkan. Tidak ada perubahan dikirim ke OLT/Modem.`
        : `ID aksi "${key}" tidak ditemukan atau sudah kedaluwarsa.`,
    };
  }
}

export type DetectedNmsIntent =
  | { readonly tool: 'cek_gangguan_jaringan' }
  | { readonly tool: 'cek_perangkat_wifi'; readonly query: string }
  | { readonly tool: 'reboot_modem'; readonly query: string }
  | { readonly tool: 'ubah_wifi_pelanggan'; readonly query: string; readonly ssid?: string; readonly password?: string }
  | { readonly tool: 'confirm_action'; readonly actionId: string }
  | { readonly tool: 'cancel_action'; readonly actionId: string };

export function detectNmsChatIntent(text: string): DetectedNmsIntent | null {
  const trimmed = text.trim();

  const confirmMatch = trimmed.match(/^\/konfirmasi(?:@\S+)?\s+([a-zA-Z0-9-]+)$/i);
  if (confirmMatch?.[1]) return { tool: 'confirm_action', actionId: confirmMatch[1] };

  const cancelMatch = trimmed.match(/^\/batal(?:@\S+)?\s+([a-zA-Z0-9-]+)$/i);
  if (cancelMatch?.[1]) return { tool: 'cancel_action', actionId: cancelMatch[1] };

  if (/^\/(olt|alarm_olt|gangguan_olt)\b/i.test(trimmed)) {
    return { tool: 'cek_gangguan_jaringan' };
  }
  if (/^(?:spv(?:\s+noc)?[,:\s]+)?(?:cek|lihat|tampilkan)\s+(?:gangguan\s+jaringan|alarm\s+olt|status\s+olt|kondisi\s+olt|semua\s+olt)\b/i.test(trimmed)) {
    return { tool: 'cek_gangguan_jaringan' };
  }

  const wifiSlash = trimmed.match(/^\/wifi(?:@\S+)?\s+(.+)$/i);
  if (wifiSlash?.[1]) return { tool: 'cek_perangkat_wifi', query: wifiSlash[1].trim() };

  const wifiNl = trimmed.match(
    /^(?:spv(?:\s+noc)?[,:\s]+)?(?:cek|lihat)\s+(?:perangkat\s+)?(?:wifi|modem|genieacs)\s+(?:pelanggan\s+)?["']?([a-zA-Z0-9._:@-]+)["']?$/i,
  );
  if (wifiNl?.[1]) return { tool: 'cek_perangkat_wifi', query: wifiNl[1].trim() };

  const rebootSlash = trimmed.match(/^\/reboot_modem(?:@\S+)?\s+(.+)$/i);
  if (rebootSlash?.[1]) return { tool: 'reboot_modem', query: rebootSlash[1].trim() };

  const rebootNl = trimmed.match(
    /^(?:spv(?:\s+noc)?[,:\s]+)?(?:tolong\s+)?(?:reboot|restart)\s+(?:modem|onu)\s+(?:pelanggan\s+)?["']?([a-zA-Z0-9._:@-]+)["']?$/i,
  );
  if (rebootNl?.[1]) return { tool: 'reboot_modem', query: rebootNl[1].trim() };

  // Format: /ubah_wifi <query> | <ssid> | <password>
  const wifiChangeSlash = trimmed.match(/^\/ubah_wifi(?:@\S+)?\s+(.+)$/i);
  if (wifiChangeSlash?.[1]) {
    const parts = wifiChangeSlash[1].split('|').map((s) => s.trim());
    if (parts[0] && (parts[1] || parts[2])) {
      return {
        tool: 'ubah_wifi_pelanggan',
        query: parts[0],
        ...(parts[1] ? { ssid: parts[1] } : {}),
        ...(parts[2] ? { password: parts[2] } : {}),
      };
    }
  }

  return null;
}
