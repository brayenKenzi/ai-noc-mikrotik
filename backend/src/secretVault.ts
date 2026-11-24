import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const PREFIX = 'enc:v1:';

/**
 * Lightweight AES-256-GCM vault for encrypting per-router MikroTik passwords at rest
 * inside data/routers.json so GUI-entered credentials are never stored in plaintext.
 */
export class SecretVault {
  private key: Buffer | null = null;
  private readonly keyPath: string;

  constructor(dataDir: string) {
    this.keyPath = path.join(dataDir, '.vault.key');
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.keyPath), { recursive: true });
    try {
      const hex = (await fs.readFile(this.keyPath, 'utf8')).trim();
      const buf = Buffer.from(hex, 'hex');
      if (buf.length === 32) {
        this.key = buf;
        return;
      }
    } catch {
      // Generate a fresh key file below
    }

    const fresh = crypto.randomBytes(32);
    await fs.writeFile(this.keyPath, fresh.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    this.key = fresh;
  }

  getSigningMaterial(): string {
    if (!this.key) {
      throw new Error('SecretVault belum diinisialisasi');
    }
    return this.key.toString('hex');
  }

  encrypt(plaintext: string): string {
    if (!plaintext) return '';
    if (!this.key) {
      throw new Error('SecretVault belum diinisialisasi');
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  decrypt(encoded: string | undefined): string {
    if (!encoded) return '';
    if (!encoded.startsWith(PREFIX)) {
      return encoded;
    }
    if (!this.key) {
      throw new Error('SecretVault belum diinisialisasi');
    }
    const body = encoded.slice(PREFIX.length);
    const [ivB64, tagB64, dataB64] = body.split(':');
    if (!ivB64 || !tagB64 || !dataB64) {
      return '';
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return decrypted.toString('utf8');
  }
}
