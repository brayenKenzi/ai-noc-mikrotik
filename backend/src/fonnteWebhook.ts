import crypto from 'node:crypto';
import { sanitizePlainAiText } from './antigravityBridge.js';

export interface FonnteIncomingPayload {
  readonly device?: string;
  readonly sender?: string;
  readonly member?: string;
  readonly name?: string;
  readonly message?: string;
  readonly text?: string;
  readonly pengirim?: string;
  readonly pesan?: string;
  readonly inboxid?: string | number;
}

export interface ParsedWaCommand {
  readonly prompt: string;
  readonly isMenuHelp: boolean;
}

/**
 * Normalizes WhatsApp sender identifiers so Indonesian numbers match cleanly
 * regardless of format (`0851...`, `62851...`, `+62851...`, `62851...@c.us`, `62851...@s.whatsapp.net`)
 * while preserving WhatsApp Group IDs (`120363xxxx@g.us`).
 */
export function normalizeWaIdentifier(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed.includes('@g.us')) {
    return trimmed;
  }
  const withoutJid = trimmed.replace(/@(c\.us|s\.whatsapp\.net)$/i, '');
  const digits = withoutJid.replace(/[^0-9]/g, '');
  if (!digits) return trimmed;
  if (digits.startsWith('0')) {
    return `62${digits.slice(1)}`;
  }
  return digits;
}

export function isWaSenderWhitelisted(
  sender: string,
  member: string | undefined,
  allowedSenders: readonly string[],
  fallbackTarget?: string,
): boolean {
  const effectiveList =
    allowedSenders.length > 0
      ? allowedSenders
      : fallbackTarget
        ? fallbackTarget.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

  if (effectiveList.length === 0) return false;
  const allowedSet = new Set(effectiveList.map(normalizeWaIdentifier).filter(Boolean));
  const normSender = normalizeWaIdentifier(sender);
  const normMember = member ? normalizeWaIdentifier(member) : '';

  if (normSender && allowedSet.has(normSender)) return true;
  if (normMember && allowedSet.has(normMember)) return true;
  return false;
}

/**
 * Parses a dot-prefixed WhatsApp message (`.status`, `.cek budi`, `.olt`, `.bagaimana kondisi router?`).
 * Returns null if the message does NOT start with `.` or is an ellipsis like `...`.
 */
export function parseDotPrefixedWaMessage(rawMessage: string): ParsedWaCommand | null {
  const trimmed = rawMessage.trim();
  if (!trimmed.startsWith('.')) return null;

  // Ignore ellipses like "..", "...", ". ."
  const body = trimmed.slice(1).trim();
  if (!body || body.startsWith('.')) return null;

  if (/^(menu|help|bantuan|perintah)$/i.test(body)) {
    return { prompt: '', isMenuHelp: true };
  }

  // Map `.command` shortcuts to SPV NOC / Telegram slash equivalents
  if (/^(status|rekap)\b/i.test(body)) {
    return {
      prompt:
        'SPV NOC, berikan laporan ringkas yang rapi untuk semua router live sekarang beserta analisa pola bandwidth, redaman SFP semua CRS, dan kesimpulan SPV AI.',
      isMenuHelp: false,
    };
  }
  if (/^sfp\b/i.test(body)) {
    return {
      prompt: 'Cek redaman optik modul SFP (RX/TX dBm dan suhu) di semua CRS Backbone dan router sekarang.',
      isMenuHelp: false,
    };
  }
  if (/^links?\b/i.test(body)) {
    return {
      prompt: 'Cek status seluruh link backbone di semua CRS, redaman SFP, serta jalur VLAN utama dan hasil ping internet sekarang.',
      isMenuHelp: false,
    };
  }
  if (/^topologi\b/i.test(body)) {
    return {
      prompt: 'Laporkan peta topologi kabel fiber yang sudah terhubung beserta status dan trafik live tiap jalurnya.',
      isMenuHelp: false,
    };
  }
  if (/^ping\b/i.test(body)) {
    return {
      prompt: 'Cek ping semua router live dan internet 1.1.1.1 serta 8.8.8.8 sekarang.',
      isMenuHelp: false,
    };
  }
  if (/^hotspot\b/i.test(body)) {
    return {
      prompt: 'Berapa total user hotspot aktif dan apakah ada user hotspot yang gagal login di semua router sekarang?',
      isMenuHelp: false,
    };
  }
  if (/^anomali\b/i.test(body)) {
    return {
      prompt: 'Apakah ada anomali, CPU kritis, ping membengkak, atau RADIUS timeout dari laporan agen NOC?',
      isMenuHelp: false,
    };
  }

  // Slash-mapped direct tools (.cek, .olt, .alarm_olt, .wifi, .reboot_modem, .ubah_wifi, .konfirmasi, .batal, .backup_rsc, .ingat)
  if (
    /^(cek|olt|alarm_olt|gangguan_olt|wifi|reboot_modem|ubah_wifi|konfirmasi|batal|backup_rsc|ingat)\b/i.test(body)
  ) {
    return { prompt: `/${body}`, isMenuHelp: false };
  }

  // Free natural-language question to SPV NOC AI (with leading dot stripped)
  return { prompt: body, isMenuHelp: false };
}

export function buildWaSpvMenuText(): string {
  return [
    `LIVE CHAT SPV NOC VIA WHATSAPP`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Awali pesan dengan titik (.) untuk memanggil SPV NOC AI. Chat biasa tanpa titik diabaikan otomatis.`,
    ``,
    `PERINTAH CEPAT:`,
    `• .status — Laporan rapi 9 router, pola bandwidth & kesimpulan SPV AI`,
    `• .cek <nama/ip/mac> — Cek pelanggan live (MikroTik + OLT + Modem)`,
    `• .olt — Cek status 6 OLT & alarm PON aktif`,
    `• .wifi <nama/mac> — Cek SSID & perangkat Wi-Fi modem (GenieACS)`,
    `• .sfp — Cek redaman optik SFP (dBm) semua CRS Backbone`,
    `• .ping — Cek ping semua router, VLAN & internet`,
    `• .topologi — Cek jalur kabel fiber manual`,
    `• .reboot_modem <nama/mac> — Reboot ONU (konfirmasi .konfirmasi <ID>)`,
    `• .ubah_wifi <user> | <ssid> | <pass> — Ubah Wi-Fi (konfirmasi 2 langkah)`,
    `• .backup_rsc — Backup .rsc semua MikroTik ke folder mikrotik-rsc/`,
    `• .ingat <info> — Ajari fakta/SOP baru permanen ke SPV NOC`,
    ``,
    `ATAU TANYA BEBAS:`,
    `• .bagaimana kondisi jaringan dan OLT malam ini?`,
  ].join('\n');
}

export function verifyWebhookSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided.trim(), 'utf8');
  const b = Buffer.from(expected.trim(), 'utf8');
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export class FonnteWebhookProcessor {
  private readonly recentMsgIds = new Map<string, number>();

  /**
   * Evaluates an incoming Fonnte webhook payload synchronously to decide whether to accept or ignore,
   * then invokes `onAskSpv` & `onReplyWa` asynchronously so the HTTP webhook responds immediately (<50ms).
   */
  handleIncoming(params: {
    readonly payload: FonnteIncomingPayload;
    readonly waChatEnabled: boolean;
    readonly allowedSenders: readonly string[];
    readonly fallbackTarget?: string;
    readonly onAskSpv: (prompt: string, actor: string) => Promise<{ readonly reply: string; readonly source: string }>;
    readonly onReplyWa: (target: string, message: string, inboxId?: string) => Promise<unknown>;
  }): { readonly accepted: boolean; readonly reason: string } {
    if (!params.waChatEnabled) {
      return { accepted: false, reason: 'wa_chat_disabled' };
    }

    const sender = String(params.payload.sender ?? params.payload.pengirim ?? '').trim();
    const device = String(params.payload.device ?? '').trim();
    const member = params.payload.member ? String(params.payload.member).trim() : undefined;
    const senderName = String(params.payload.name ?? '').trim();
    const inboxId = params.payload.inboxid !== undefined ? String(params.payload.inboxid).trim() : undefined;
    const rawMsg = String(params.payload.message ?? params.payload.text ?? params.payload.pesan ?? '').trim();

    if (!sender || !rawMsg) {
      return { accepted: false, reason: 'empty_payload' };
    }

    // Anti-loop: never reply to messages originating from the bot's own device number
    if (
      device &&
      (normalizeWaIdentifier(sender) === normalizeWaIdentifier(device) ||
        (member && normalizeWaIdentifier(member) === normalizeWaIdentifier(device)))
    ) {
      console.log(`[FonnteWebhook] ignored self_loop sender=${sender} member=${member ?? '-'}`);
      return { accepted: false, reason: 'self_loop_ignored' };
    }

    // Prefix `.` trigger check BEFORE whitelist so non-command chats are ignored instantly
    const parsed = parseDotPrefixedWaMessage(rawMsg);
    if (!parsed) {
      return { accepted: false, reason: 'no_dot_prefix' };
    }

    // Strict Whitelist check (supports personal WA numbers & @g.us group IDs)
    if (!isWaSenderWhitelisted(sender, member, params.allowedSenders, params.fallbackTarget)) {
      console.log(`[FonnteWebhook] blocked sender_not_whitelisted sender=${sender} member=${member ?? '-'}`);
      return { accepted: false, reason: 'sender_not_whitelisted' };
    }

    // Deduplicate identical webhook retries within 12 seconds
    const now = Date.now();
    for (const [k, ts] of this.recentMsgIds.entries()) {
      if (now - ts > 15_000) this.recentMsgIds.delete(k);
    }
    const dedupKey = `${normalizeWaIdentifier(sender)}:${rawMsg.slice(0, 80)}`;
    if (this.recentMsgIds.has(dedupKey)) {
      return { accepted: false, reason: 'duplicate_ignored' };
    }
    this.recentMsgIds.set(dedupKey, now);

    const actorLabel = senderName ? `WhatsApp (${senderName})` : `WhatsApp (${sender})`;
    console.log(`[FonnteWebhook] accepted sender=${sender} member=${member ?? '-'} isMenu=${parsed.isMenuHelp}`);

    void (async () => {
      try {
        if (parsed.isMenuHelp) {
          const sendRes = (await params.onReplyWa(sender, buildWaSpvMenuText(), inboxId)) as
            | { ok?: boolean; detail?: string }
            | undefined;
          if (sendRes && sendRes.ok === false) {
            console.warn(`[FonnteWebhook] reply failed target=${sender}: ${sendRes.detail ?? 'unknown'}`);
          }
          return;
        }
        const res = await params.onAskSpv(parsed.prompt, actorLabel);
        const cleanReply = sanitizePlainAiText(res.reply);
        const sendRes = (await params.onReplyWa(sender, `${cleanReply}\n\n[${res.source}]`, inboxId)) as
          | { ok?: boolean; detail?: string }
          | undefined;
        if (sendRes && sendRes.ok === false) {
          console.warn(`[FonnteWebhook] reply failed target=${sender}: ${sendRes.detail ?? 'unknown'}`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Gagal memproses permintaan SPV NOC';
        console.warn(`[FonnteWebhook] error target=${sender}: ${errMsg}`);
        await params.onReplyWa(sender, `Maaf, terjadi kendala saat memproses permintaan SPV NOC: ${errMsg}`, inboxId).catch(() => {});
      }
    })();

    return { accepted: true, reason: 'processing' };
  }
}
