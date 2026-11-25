export interface NmsPppoeInfo {
  readonly mac?: string;
  readonly username?: string;
  readonly address?: string;
  readonly ip?: string;
  readonly uptime?: string;
  readonly txGB?: number;
  readonly rxGB?: number;
  readonly txBps?: number;
  readonly rxBps?: number;
  readonly routerId?: string;
  readonly routerName?: string;
  readonly state?: string;
}

export interface NmsOnuRow {
  readonly index: string;
  readonly name: string;
  readonly mac: string;
  readonly status: string;
  readonly rx?: number | string | null;
  readonly rxDrop?: boolean | number | null;
  readonly pppoe?: NmsPppoeInfo | null;
}

export interface NmsOltItem {
  readonly name: string;
  readonly host: string;
  readonly rows: readonly NmsOnuRow[];
  readonly updated?: string | number | null;
  readonly error?: string | null;
  readonly polling?: boolean;
  readonly liveOk?: boolean;
  readonly networkUnreachable?: boolean;
  readonly directRestart?: boolean;
}

export interface NmsAlarmItem {
  readonly id?: string | number;
  readonly key?: string;
  readonly at?: string | number;
  readonly until?: string | number | null;
  readonly kind?: string;
  readonly title?: string;
  readonly detail?: string;
}

export interface NmsOnuSearchMatch {
  readonly oltName: string;
  readonly oltHost: string;
  readonly oltLiveOk: boolean;
  readonly onu: NmsOnuRow;
}

export interface NmsClientOptions {
  readonly baseUrl?: string;
  readonly username?: string;
  readonly password?: string;
  readonly timeoutMs?: number;
  readonly oltsCacheTtlMs?: number;
}

/**
 * Pure HTTP REST connector for ADT Monitoring NMS (`http://127.0.0.1:8080`).
 * Security & Protocol guarantees:
 * - Never touches SQLite or `olts.json` directly.
 * - Sends exact `Content-Type: application/json` (no charset suffix) on all POST requests.
 * - Sends `Origin: <baseUrl origin>` on operational write endpoints for CSRF validation.
 * - Reuses `momo_session` cookie in memory and auto-relogins only on HTTP 401 (single-flight mutex).
 * - Never exposes `/api/onu/delete` or `/api/admin/*`.
 */
export class NmsClient {
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly oltsCacheTtlMs: number;

  private sessionCookie: string | null = null;
  private loginInFlight: Promise<string> | null = null;
  private oltsCache: { readonly fetchedAt: number; readonly data: readonly NmsOltItem[] } | null = null;

  constructor(options: NmsClientOptions = {}) {
    const rawBase = (options.baseUrl ?? process.env.NMS_BASE_URL ?? 'http://127.0.0.1:8080').trim().replace(/\/+$/, '');
    this.baseUrl = rawBase || 'http://127.0.0.1:8080';
    this.origin = new URL(this.baseUrl).origin;
    this.username = (options.username ?? process.env.NMS_USERNAME ?? '').trim();
    this.password = (options.password ?? process.env.NMS_PASSWORD ?? '').trim();
    this.timeoutMs = Math.max(3000, Math.min(20_000, options.timeoutMs ?? 10_000));
    this.oltsCacheTtlMs = Math.max(2000, Math.min(30_000, options.oltsCacheTtlMs ?? 12_000));
  }

  get isConfigured(): boolean {
    return this.baseUrl.length > 0 && this.username.length > 0 && this.password.length > 0;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  clearCache(): void {
    this.oltsCache = null;
  }

  private extractSessionCookie(resp: Response): string | null {
    const headersObj = resp.headers as Headers & { getSetCookie?: () => string[] };
    const candidates: string[] = [];
    if (typeof headersObj.getSetCookie === 'function') {
      candidates.push(...headersObj.getSetCookie());
    }
    const single = resp.headers.get('set-cookie');
    if (single) candidates.push(single);

    for (const raw of candidates) {
      const m = raw.match(/momo_session=([a-fA-F0-9]+)/);
      if (m?.[1]) {
        return `momo_session=${m[1]}`;
      }
    }
    return null;
  }

  private async ensureSession(forceRelogin = false): Promise<string> {
    if (!this.isConfigured) {
      throw new Error('ADT Monitoring NMS belum dikonfigurasi (isi NMS_BASE_URL, NMS_USERNAME, NMS_PASSWORD di .env)');
    }
    if (!forceRelogin && this.sessionCookie) {
      return this.sessionCookie;
    }
    if (this.loginInFlight) {
      return this.loginInFlight;
    }

    this.loginInFlight = (async () => {
      const resp = await fetch(`${this.baseUrl}/api/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: this.username,
          password: this.password,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => '');
        throw new Error(`Login ADT Monitoring NMS gagal (HTTP ${resp.status}): ${bodyText.slice(0, 140)}`);
      }
      const cookie = this.extractSessionCookie(resp);
      if (!cookie) {
        throw new Error('Login ADT Monitoring NMS berhasil namun cookie momo_session tidak ditemukan');
      }
      this.sessionCookie = cookie;
      return cookie;
    })();

    try {
      return await this.loginInFlight;
    } finally {
      this.loginInFlight = null;
    }
  }

  private async requestJson<T>(options: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly body?: unknown;
    readonly requireOrigin?: boolean;
    readonly timeoutMs?: number;
  }): Promise<T> {
    const runOnce = async (cookie: string): Promise<Response> => {
      const headers: Record<string, string> = {
        Cookie: cookie,
      };
      if (options.method === 'POST') {
        // Strict requirement: exact 'application/json' without charset suffix
        headers['Content-Type'] = 'application/json';
      }
      if (options.requireOrigin) {
        headers['Origin'] = this.origin;
      }
      return fetch(`${this.baseUrl}${options.path}`, {
        method: options.method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      });
    };

    let cookie = await this.ensureSession(false);
    let resp = await runOnce(cookie);

    if (resp.status === 401) {
      // Auto-relogin once on expired/invalid session
      this.sessionCookie = null;
      cookie = await this.ensureSession(true);
      resp = await runOnce(cookie);
    }

    const rawText = await resp.text();
    let parsed: unknown = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = rawText;
    }

    if (!resp.ok) {
      const errMsg =
        parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : typeof parsed === 'string' && parsed.trim()
            ? parsed.trim().slice(0, 180)
            : `HTTP ${resp.status}`;
      throw new Error(`ADT Monitoring NMS error (${options.path}): ${errMsg}`);
    }

    return parsed as T;
  }

  // --- A. Read-Only Endpoints ---

  async getOlts(bypassCache = false): Promise<readonly NmsOltItem[]> {
    const now = Date.now();
    if (!bypassCache && this.oltsCache && now - this.oltsCache.fetchedAt < this.oltsCacheTtlMs) {
      return this.oltsCache.data;
    }
    const raw = await this.requestJson<unknown>({ method: 'GET', path: '/api/olts' });
    const data: readonly NmsOltItem[] = Array.isArray(raw) ? (raw as NmsOltItem[]) : [];
    this.oltsCache = { fetchedAt: now, data };
    return data;
  }

  async searchOnus(query: string, bypassCache = false): Promise<readonly NmsOnuSearchMatch[]> {
    const clean = query.trim().toLowerCase();
    if (clean.length < 2) return [];
    const normalizedMacQuery = clean.replace(/[^a-f0-9]/g, '');

    const olts = await this.getOlts(bypassCache);
    const matches: NmsOnuSearchMatch[] = [];

    for (const olt of olts) {
      const rows = Array.isArray(olt.rows) ? olt.rows : [];
      for (const onu of rows) {
        const name = (onu.name ?? '').toLowerCase();
        const mac = (onu.mac ?? '').toLowerCase();
        const macCompact = mac.replace(/[^a-f0-9]/g, '');
        const pppUser = (onu.pppoe?.username ?? '').toLowerCase();
        const pppIp = (onu.pppoe?.address ?? onu.pppoe?.ip ?? '').toLowerCase();
        const idx = (onu.index ?? '').toLowerCase();

        const isMatch =
          name.includes(clean) ||
          pppUser.includes(clean) ||
          mac.includes(clean) ||
          pppIp.includes(clean) ||
          idx === clean ||
          (normalizedMacQuery.length >= 6 && macCompact.includes(normalizedMacQuery));

        if (isMatch) {
          matches.push({
            oltName: olt.name || olt.host,
            oltHost: olt.host,
            oltLiveOk: Boolean(olt.liveOk && !olt.networkUnreachable),
            onu,
          });
        }
      }
    }

    // Prioritize exact username/name/MAC matches first
    matches.sort((a, b) => {
      const aExact =
        (a.onu.pppoe?.username ?? '').toLowerCase() === clean ||
        (a.onu.name ?? '').toLowerCase() === clean ||
        (a.onu.mac ?? '').toLowerCase() === clean
          ? 0
          : 1;
      const bExact =
        (b.onu.pppoe?.username ?? '').toLowerCase() === clean ||
        (b.onu.name ?? '').toLowerCase() === clean ||
        (b.onu.mac ?? '').toLowerCase() === clean
          ? 0
          : 1;
      return aExact - bExact;
    });

    return matches;
  }

  async getOnuDetail(
    host: string,
    mac: string,
    index: string,
    days: 'hour' | '1' | '7' = '1',
  ): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({ host, mac, index, days });
    return this.requestJson<Record<string, unknown>>({
      method: 'GET',
      path: `/api/onu/detail?${qs.toString()}`,
    });
  }

  async getHistory(
    host: string,
    mac: string,
    index: string,
    days: 'hour' | '1' | '7' = '1',
  ): Promise<unknown> {
    const qs = new URLSearchParams({ host, mac, index, days });
    return this.requestJson<unknown>({
      method: 'GET',
      path: `/api/history?${qs.toString()}`,
    });
  }

  async getAlarms(): Promise<readonly NmsAlarmItem[]> {
    const raw = await this.requestJson<unknown>({ method: 'GET', path: '/api/alarms' });
    return Array.isArray(raw) ? (raw as NmsAlarmItem[]) : [];
  }

  async getGenieAcsDevice(
    host: string,
    mac: string,
    index: string,
    summon: 0 | 1 = 1,
    force: 0 | 1 = 0,
  ): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({
      host,
      mac,
      index,
      summon: String(summon),
      force: String(force),
    });
    return this.requestJson<Record<string, unknown>>({
      method: 'GET',
      path: `/api/genieacs/device?${qs.toString()}`,
      timeoutMs: summon === 1 ? Math.max(this.timeoutMs, 12_000) : this.timeoutMs,
    });
  }

  // --- B. Operational Write Endpoints (Guarded by Human Confirmation in NmsToolSuite) ---

  async refreshOlt(host?: string): Promise<Record<string, unknown>> {
    this.oltsCache = null;
    return this.requestJson<Record<string, unknown>>({
      method: 'POST',
      path: '/api/olt/refresh',
      body: host ? { host } : {},
      requireOrigin: true,
    });
  }

  async restartOnu(
    host: string,
    index: string,
    mac: string,
    action: 'verify' | 'reboot',
  ): Promise<Record<string, unknown>> {
    if (action === 'reboot') {
      this.oltsCache = null;
    }
    return this.requestJson<Record<string, unknown>>({
      method: 'POST',
      path: '/api/onu/restart',
      body: { host, index, mac, action },
      requireOrigin: true,
    });
  }

  async updateGenieAcsWifi(
    host: string,
    mac: string,
    index: string,
    ssid?: string,
    password?: string,
  ): Promise<Record<string, unknown>> {
    const cleanSsid = ssid !== undefined ? ssid.trim() : undefined;
    const cleanPass = password !== undefined ? password : undefined;

    if (!cleanSsid && !cleanPass) {
      throw new Error('Minimal isi SSID baru atau Password Wi-Fi baru');
    }
    if (cleanSsid !== undefined && (cleanSsid.length < 1 || cleanSsid.length > 32)) {
      throw new Error('SSID Wi-Fi harus antara 1 sampai 32 karakter');
    }
    if (cleanPass !== undefined && (cleanPass.length < 8 || cleanPass.length > 63)) {
      throw new Error('Password Wi-Fi harus antara 8 sampai 63 karakter');
    }

    const payload: Record<string, string> = { host, mac, index };
    if (cleanSsid !== undefined) payload.ssid = cleanSsid;
    if (cleanPass !== undefined) payload.password = cleanPass;

    return this.requestJson<Record<string, unknown>>({
      method: 'POST',
      path: '/api/genieacs/wifi',
      body: payload,
      requireOrigin: true,
      timeoutMs: Math.max(this.timeoutMs, 12_000),
    });
  }
}
