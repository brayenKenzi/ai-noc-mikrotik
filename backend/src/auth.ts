import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

interface StoredAdminRecord {
  readonly username: string;
  readonly saltHex: string;
  readonly hashHex: string;
  readonly updatedAt: string;
}

export interface SessionPayload {
  readonly u: string;
  readonly exp: number;
}

const SESSION_COOKIE_NAME = 'noc_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function hashPassword(password: string, saltHex: string): string {
  return crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      result[key] = decodeURIComponent(val);
    }
  }
  return result;
}

export class AdminAuthManager {
  private readonly authFilePath: string;
  private readonly signingSecret: Buffer;
  private record: StoredAdminRecord | null = null;
  private readonly loginFailures = new Map<string, number[]>();

  constructor(dataDir: string, signingKeyMaterial: string) {
    this.authFilePath = path.join(dataDir, 'admin-auth.json');
    this.signingSecret = crypto.createHash('sha256').update(signingKeyMaterial).digest();
  }

  get cookieName(): string {
    return SESSION_COOKIE_NAME;
  }

  async init(defaultUsername: string, defaultPassword: string): Promise<boolean> {
    await fs.mkdir(path.dirname(this.authFilePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.authFilePath, 'utf8');
      const parsed = JSON.parse(raw) as StoredAdminRecord;
      if (parsed.username && parsed.saltHex && parsed.hashHex) {
        this.record = parsed;
        return false;
      }
    } catch {
      // Seed initial admin credentials
    }
    await this.saveCredentials(defaultUsername, defaultPassword);
    return true;
  }

  getUsername(): string {
    return this.record?.username ?? 'admin';
  }

  isRateLimited(ip: string): boolean {
    const now = Date.now();
    const windowStart = now - 5 * 60_000;
    const recent = (this.loginFailures.get(ip) ?? []).filter((t) => t > windowStart);
    this.loginFailures.set(ip, recent);
    return recent.length >= 10;
  }

  verifyLogin(username: string, password: string, ip: string): { readonly ok: boolean; readonly error?: string } {
    if (this.isRateLimited(ip)) {
      return { ok: false, error: 'Terlalu banyak percobaan login gagal. Coba lagi 5 menit lagi.' };
    }
    if (!this.record) {
      return { ok: false, error: 'Autentikasi belum siap' };
    }
    const candidateHash = hashPassword(password, this.record.saltHex);
    const userOk = constantTimeEquals(username.trim(), this.record.username);
    const passOk = constantTimeEquals(candidateHash, this.record.hashHex);
    if (!userOk || !passOk) {
      const prev = this.loginFailures.get(ip) ?? [];
      this.loginFailures.set(ip, [...prev, Date.now()]);
      return { ok: false, error: 'Username atau password admin salah' };
    }
    this.loginFailures.delete(ip);
    return { ok: true };
  }

  async changeCredentials(
    currentPassword: string,
    newUsername: string,
    newPassword: string,
  ): Promise<void> {
    if (!this.record) {
      throw new Error('Autentikasi belum siap');
    }
    const curHash = hashPassword(currentPassword, this.record.saltHex);
    if (!constantTimeEquals(curHash, this.record.hashHex)) {
      throw new Error('Password lama tidak cocok');
    }
    await this.saveCredentials(newUsername.trim() || this.record.username, newPassword);
  }

  issueSessionToken(username: string): string {
    const payload: SessionPayload = {
      u: username,
      exp: Date.now() + SESSION_TTL_MS,
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', this.signingSecret).update(encoded).digest('base64url');
    return `${encoded}.${sig}`;
  }

  verifySessionToken(token: string | undefined): SessionPayload | null {
    if (!token) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const encoded = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expectedSig = crypto.createHmac('sha256', this.signingSecret).update(encoded).digest('base64url');
    if (!constantTimeEquals(sig, expectedSig)) {
      return null;
    }
    try {
      const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
      if (!parsed.u || typeof parsed.exp !== 'number' || parsed.exp < Date.now()) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  verifyCookieHeader(cookieHeader: string | undefined): SessionPayload | null {
    const cookies = parseCookieHeader(cookieHeader);
    return this.verifySessionToken(cookies[SESSION_COOKIE_NAME]);
  }

  buildSetCookieHeader(token: string): string {
    const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
  }

  buildClearCookieHeader(): string {
    return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  private async saveCredentials(username: string, password: string): Promise<void> {
    const saltHex = crypto.randomBytes(16).toString('hex');
    const hashHex = hashPassword(password, saltHex);
    const rec: StoredAdminRecord = {
      username,
      saltHex,
      hashHex,
      updatedAt: new Date().toISOString(),
    };
    const tmp = `${this.authFilePath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(rec, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.authFilePath);
    this.record = rec;
  }
}
