import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

/**
 * Pure Node.js client for MikroTik RouterOS API (port 8728 / 8729).
 * Compatible with both RouterOS v6 (MD5 challenge & post-6.43 plain login) and RouterOS v7.
 */
export function encodeLength(len: number): Buffer {
  if (len < 0x80) {
    return Buffer.from([len]);
  }
  if (len < 0x4000) {
    const v = len | 0x8000;
    return Buffer.from([(v >> 8) & 0xff, v & 0xff]);
  }
  if (len < 0x200000) {
    const v = len | 0xc00000;
    return Buffer.from([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  }
  if (len < 0x10000000) {
    const v = len | 0xe0000000;
    return Buffer.from([(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  }
  return Buffer.from([0xf0, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

export function encodeSentence(words: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const word of words) {
    const wordBuf = Buffer.from(word, 'utf8');
    chunks.push(encodeLength(wordBuf.length), wordBuf);
  }
  chunks.push(Buffer.from([0x00]));
  return Buffer.concat(chunks);
}

export function decodeWordsFromBuffer(buf: Buffer): { sentences: string[][]; remaining: Buffer } {
  const sentences: string[][] = [];
  let offset = 0;
  let currentSentence: string[] = [];

  while (offset < buf.length) {
    const b0 = buf[offset]!;
    let wordLen = 0;
    let headerLen = 1;

    if ((b0 & 0x80) === 0x00) {
      wordLen = b0;
      headerLen = 1;
    } else if ((b0 & 0xc0) === 0x80) {
      if (offset + 2 > buf.length) break;
      wordLen = ((b0 & 0x3f) << 8) | buf[offset + 1]!;
      headerLen = 2;
    } else if ((b0 & 0xe0) === 0xc0) {
      if (offset + 3 > buf.length) break;
      wordLen = ((b0 & 0x1f) << 16) | (buf[offset + 1]! << 8) | buf[offset + 2]!;
      headerLen = 3;
    } else if ((b0 & 0xf0) === 0xe0) {
      if (offset + 4 > buf.length) break;
      wordLen =
        (((b0 & 0x0f) << 24) | (buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!) >>> 0;
      headerLen = 4;
    } else {
      if (offset + 5 > buf.length) break;
      wordLen =
        ((buf[offset + 1]! << 24) | (buf[offset + 2]! << 16) | (buf[offset + 3]! << 8) | buf[offset + 4]!) >>> 0;
      headerLen = 5;
    }

    if (wordLen === 0) {
      offset += headerLen;
      if (currentSentence.length > 0) {
        sentences.push(currentSentence);
        currentSentence = [];
      }
      continue;
    }

    if (offset + headerLen + wordLen > buf.length) {
      break;
    }

    const word = buf.subarray(offset + headerLen, offset + headerLen + wordLen).toString('utf8');
    currentSentence.push(word);
    offset += headerLen + wordLen;
  }

  return {
    sentences,
    remaining: buf.subarray(offset),
  };
}

export function parseSentenceAttributes(sentence: readonly string[]): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const word of sentence) {
    if (word.startsWith('=')) {
      const idx = word.indexOf('=', 1);
      if (idx > 1) {
        const key = word.slice(1, idx);
        const val = word.slice(idx + 1);
        attrs[key] = val;
      }
    }
  }
  return attrs;
}

/**
 * Inspects a RouterOS /login reply sentence array to determine whether login succeeded,
 * requires a legacy pre-6.43 MD5 challenge, or failed with a !trap / !fatal message.
 */
export function evaluateLoginReply(sentences: readonly (readonly string[])[]): {
  readonly status: 'ok' | 'challenge' | 'error';
  readonly challengeHex?: string;
  readonly errorMessage?: string;
} {
  const trap = sentences.find((s) => s[0] === '!trap' || s[0] === '!fatal');
  if (trap) {
    const attrs = parseSentenceAttributes(trap);
    return {
      status: 'error',
      errorMessage: attrs.message ?? 'Authentication rejected by RouterOS (!trap)',
    };
  }
  const done = sentences.find((s) => s[0] === '!done');
  if (!done) {
    return { status: 'error', errorMessage: 'Missing !done reply during RouterOS authentication' };
  }
  const doneAttrs = parseSentenceAttributes(done);
  if (doneAttrs.ret) {
    return { status: 'challenge', challengeHex: doneAttrs.ret };
  }
  return { status: 'ok' };
}

export interface RouterOsConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly useTls: boolean;
  readonly username: string;
  readonly secret: string;
  readonly timeoutMs?: number;
}

export interface RouterOsCommandOutcome {
  readonly ok: boolean;
  readonly rows: Record<string, string>[];
  readonly doneAttrs: Record<string, string>;
  readonly error?: string;
}

export class RouterOsClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private readonly options: RouterOsConnectionOptions;

  constructor(options: RouterOsConnectionOptions) {
    this.options = options;
  }

  async connectAndRun(commands: readonly (readonly string[])[]): Promise<Record<string, string>[][]> {
    const timeoutMs = this.options.timeoutMs ?? 6000;
    await this.openSocket(timeoutMs);
    try {
      await this.authenticate(timeoutMs);
      const results: Record<string, string>[][] = [];
      for (const cmd of commands) {
        const rows = await this.sendCommand(cmd, timeoutMs);
        results.push(rows);
      }
      return results;
    } finally {
      this.close();
    }
  }

  /**
   * Executes a custom async callback with an authenticated session so multi-step
   * lookup-then-mutate commands (e.g. find .id then remove/set) reuse one socket cleanly.
   */
  async withSession<T>(
    fn: (run: (words: readonly string[]) => Promise<Record<string, string>[]>) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = this.options.timeoutMs ?? 6000;
    await this.openSocket(timeoutMs);
    try {
      await this.authenticate(timeoutMs);
      return await fn((words) => this.sendCommand(words, timeoutMs));
    } finally {
      this.close();
    }
  }

  /**
   * Executes multiple commands over a single authenticated session while tolerating
   * optional command traps (e.g., CRS switches without PPP or BGP packages installed).
   */
  async connectAndRunTolerant(commands: readonly (readonly string[])[]): Promise<RouterOsCommandOutcome[]> {
    const timeoutMs = this.options.timeoutMs ?? 6000;
    await this.openSocket(timeoutMs);
    try {
      await this.authenticate(timeoutMs);
      const results: RouterOsCommandOutcome[] = [];
      for (const cmd of commands) {
        const sentences = await this.exchange(cmd, timeoutMs);
        const trap = sentences.find((s) => s[0] === '!trap' || s[0] === '!fatal');
        const done = sentences.find((s) => s[0] === '!done');
        const doneAttrs = done ? parseSentenceAttributes(done) : {};
        if (trap) {
          const errAttrs = parseSentenceAttributes(trap);
          results.push({
            ok: false,
            rows: [],
            doneAttrs,
            error: errAttrs.message ?? 'RouterOS command failed (!trap)',
          });
        } else {
          results.push({
            ok: true,
            rows: sentences.filter((s) => s[0] === '!re').map((s) => parseSentenceAttributes(s)),
            doneAttrs,
          });
        }
      }
      return results;
    } finally {
      this.close();
    }
  }

  private openSocket(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onTimeout = () => {
        cleanup();
        this.close();
        reject(new Error(`Connection timeout to ${this.options.host}:${this.options.port}`));
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        this.socket?.removeListener('error', onError);
        this.socket?.removeListener('timeout', onTimeout);
      };

      if (this.options.useTls) {
        this.socket = tls.connect(
          {
            host: this.options.host,
            port: this.options.port,
            rejectUnauthorized: false,
          },
          onConnect,
        );
      } else {
        this.socket = net.createConnection(
          {
            host: this.options.host,
            port: this.options.port,
          },
          onConnect,
        );
      }
      this.socket.setTimeout(timeoutMs);
      this.socket.once('error', onError);
      this.socket.once('timeout', onTimeout);
    });
  }

  private async authenticate(timeoutMs: number): Promise<void> {
    // Post RouterOS v6.43 & RouterOS v7 login format
    const reply = await this.exchange(
      ['/login', `=name=${this.options.username}`, `=password=${this.options.secret}`],
      timeoutMs,
    );
    const evalFirst = evaluateLoginReply(reply);
    if (evalFirst.status === 'ok') {
      return;
    }
    if (evalFirst.status === 'challenge' && evalFirst.challengeHex) {
      await this.completeLegacyChallenge(evalFirst.challengeHex, timeoutMs);
      return;
    }
    throw new Error(`${evalFirst.errorMessage ?? 'Authentication rejected'} (${this.options.host})`);
  }

  private async completeLegacyChallenge(challengeHex: string, timeoutMs: number): Promise<void> {
    const challenge = Buffer.from(challengeHex, 'hex');
    const md5 = crypto.createHash('md5');
    md5.update(Buffer.from([0x00]));
    md5.update(Buffer.from(this.options.secret, 'utf8'));
    md5.update(challenge);
    const responseHex = `00${md5.digest('hex')}`;
    const legacyReply = await this.exchange(
      ['/login', `=name=${this.options.username}`, `=response=${responseHex}`],
      timeoutMs,
    );
    const evalLegacy = evaluateLoginReply(legacyReply);
    if (evalLegacy.status !== 'ok') {
      throw new Error(`${evalLegacy.errorMessage ?? 'Legacy authentication rejected'} (${this.options.host})`);
    }
  }

  private async sendCommand(words: readonly string[], timeoutMs: number): Promise<Record<string, string>[]> {
    const sentences = await this.exchange(words, timeoutMs);
    const trap = sentences.find((s) => s[0] === '!trap' || s[0] === '!fatal');
    if (trap) {
      const errAttrs = parseSentenceAttributes(trap);
      throw new Error(errAttrs.message ?? 'RouterOS command failed (!trap)');
    }
    return sentences.filter((s) => s[0] === '!re').map((s) => parseSentenceAttributes(s));
  }

  private exchange(words: readonly string[], timeoutMs: number): Promise<string[][]> {
    return new Promise((resolve, reject) => {
      const sock = this.socket;
      if (!sock) {
        reject(new Error('Socket is not connected'));
        return;
      }

      let buffer: Buffer = Buffer.alloc(0);
      const collected: string[][] = [];

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Command timeout on ${this.options.host}`));
      }, timeoutMs);

      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = decodeWordsFromBuffer(buffer);
        buffer = Buffer.from(decoded.remaining);
        for (const s of decoded.sentences) {
          collected.push(s);
          if (s[0] === '!done' || s[0] === '!fatal') {
            cleanup();
            resolve(collected);
            return;
          }
        }
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const onClose = () => {
        cleanup();
        reject(new Error(`Connection closed unexpectedly by ${this.options.host}:${this.options.port}`));
      };

      const cleanup = () => {
        clearTimeout(timer);
        sock.removeListener('data', onData);
        sock.removeListener('error', onError);
        sock.removeListener('close', onClose);
      };

      sock.on('data', onData);
      sock.once('error', onError);
      sock.once('close', onClose);
      sock.write(encodeSentence(words));
    });
  }

  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}
