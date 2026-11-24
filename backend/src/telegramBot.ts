import type { ApprovalTicket } from './types.js';
import { sanitizePlainAiText } from './antigravityBridge.js';

export interface TelegramBotCallbacks {
  readonly onApprove: (ticketId: string, actor: string) => Promise<ApprovalTicket>;
  readonly onReject: (ticketId: string, actor: string) => Promise<ApprovalTicket>;
  readonly onSpvChat?: (question: string, actor: string) => Promise<{ readonly reply: string; readonly source: string }>;
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly message_id: number;
    readonly date?: number;
    readonly text?: string;
    readonly from?: { readonly username?: string; readonly first_name?: string };
    readonly chat?: { readonly id?: number | string };
  };
  readonly callback_query?: {
    readonly id: string;
    readonly from?: { readonly username?: string; readonly first_name?: string };
    readonly message?: { readonly chat?: { readonly id?: number | string } };
    readonly data?: string;
  };
}

/**
 * 2-Way Telegram Bot Integration (Long Polling via native HTTPS fetch):
 * 1. Live Chat directly with centralized SPV NOC AI (synced with Web Dashboard!).
 * 2. Interactive Inline Keyboard [✅ Setujui Eksekusi] [❌ Tolak] approval cards.
 * 3. Real-time anomaly alert notifications in clean plain text (ZERO asterisks).
 */
export class TelegramNocBot {
  private readonly token: string;
  private readonly allowedChatIds: readonly string[];
  private readonly primaryChatId: string;
  private readonly callbacks: TelegramBotCallbacks;
  private running = false;
  private updateOffset = 0;
  private startedAtSec = 0;

  constructor(token: string, allowedChatId: string, callbacks: TelegramBotCallbacks) {
    this.token = token.trim();
    this.allowedChatIds = allowedChatId
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.primaryChatId = this.allowedChatIds[0] ?? '';
    this.callbacks = callbacks;
  }

  get isEnabled(): boolean {
    return this.token.length > 0 && this.primaryChatId.length > 0;
  }

  private isAuthorizedChat(chatId: string): boolean {
    return this.allowedChatIds.includes(chatId);
  }

  start(): void {
    if (!this.isEnabled || this.running) return;
    this.running = true;
    this.startedAtSec = Math.floor(Date.now() / 1000);
    console.log(`[AI-NOC] Telegram Live Chat SPV NOC aktif untuk Chat ID: ${this.allowedChatIds.join(', ')}`);
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
  }

  async sendPlainAlert(message: string): Promise<boolean> {
    if (!this.isEnabled) return false;
    const clean = sanitizePlainAiText(message);
    return this.sendLongMessage(this.primaryChatId, clean);
  }

  async sendApprovalRequestCard(ticket: ApprovalTicket): Promise<void> {
    if (!this.isEnabled) return;

    const text = sanitizePlainAiText(
      [
        `🚨 SPV NOC — MENUNGGU PERSETUJUAN TINDAKAN`,
        `• TIKET: #${ticket.id}`,
        `• ROUTER: ${ticket.routerName}`,
        `• AGEN: ${ticket.agentName}`,
        `• RISIKO: ${ticket.proposal.riskLevel}`,
        ``,
        `INSIDEN: ${ticket.incidentSummary}`,
        `ANALISIS: ${ticket.rootCauseAnalysis}`,
        ``,
        `PERINTAH MIKROTIK DIUSULKAN:`,
        ticket.proposal.previewCommand,
        ``,
        `ROLLBACK:`,
        ticket.proposal.rollbackCommand,
      ].join('\n'),
    );

    await this.callTelegram('sendMessage', {
      chat_id: this.primaryChatId,
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Setujui & Eksekusi', callback_data: `approve:${ticket.id}` },
            { text: '❌ Tolak', callback_data: `reject:${ticket.id}` },
          ],
        ],
      },
    });
  }

  async sendExecutionUpdate(ticket: ApprovalTicket): Promise<void> {
    if (!this.isEnabled) return;
    const icon = ticket.status === 'EXECUTED' ? '✅' : ticket.status === 'REJECTED' ? '🚫' : '⚠️';
    const text = sanitizePlainAiText(
      [
        `${icon} UPDATE TIKET #${ticket.id} (${ticket.routerName})`,
        `STATUS: ${ticket.status} oleh ${ticket.decidedBy ?? 'Admin'}`,
        ticket.executionResult ? `HASIL: ${ticket.executionResult}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    await this.callTelegram('sendMessage', {
      chat_id: this.primaryChatId,
      text,
    });
  }

  private async pollLoop(): Promise<void> {
    // Skip backlog updates older than startup so restarts never replay old chats
    try {
      const initRes = await this.callTelegram('getUpdates', { offset: -1, timeout: 0 });
      const initUpdates = (initRes?.result ?? []) as TelegramUpdate[];
      const last = initUpdates[initUpdates.length - 1];
      if (last) {
        this.updateOffset = last.update_id + 1;
      }
    } catch {
      // Continue cleanly
    }

    while (this.running) {
      try {
        const res = await this.callTelegram('getUpdates', {
          offset: this.updateOffset,
          timeout: 20,
          allowed_updates: ['message', 'callback_query'],
        });

        if (!res) {
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }

        const updates = (res.result ?? []) as TelegramUpdate[];

        for (const u of updates) {
          this.updateOffset = u.update_id + 1;

          if (u.callback_query) {
            await this.handleCallbackQuery(u.callback_query);
          } else if (u.message?.text) {
            await this.handleIncomingMessage(u.message);
          }
        }
      } catch {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async handleIncomingMessage(msg: NonNullable<TelegramUpdate['message']>): Promise<void> {
    const chatId = String(msg.chat?.id ?? '');
    const rawText = (msg.text ?? '').trim();
    if (!chatId || !rawText) return;

    // Ignore stale messages older than 2 minutes before startup
    if (msg.date && msg.date < this.startedAtSec - 120) {
      return;
    }

    if (!this.isAuthorizedChat(chatId)) {
      await this.callTelegram('sendMessage', {
        chat_id: chatId,
        text: '⛔ AKSES DITOLAK: Bot SPV NOC ini khusus untuk Admin NOC yang terdaftar.',
      });
      return;
    }

    const senderName = msg.from?.username || msg.from?.first_name || 'Boss';
    const actor = `Telegram (${senderName})`;

    if (/^\/(start|help)\b/i.test(rawText)) {
      await this.sendLongMessage(
        chatId,
        [
          `👑 LIVE CHAT SPV NOC AKTIF!`,
          `Halo ${senderName}, Telegram Anda sekarang terhubung langsung dengan SPV NOC AI Supervisor (sinkron dengan Dashboard Cafe Datacenter).`,
          ``,
          `ANDA BISA LANGSUNG CHAT APA SAJA, MISALNYA:`,
          `• "Berapa user hotspot dan PPPoE aktif sekarang?"`,
          `• "Cek kondisi CCR MomoNet dan QairenNet"`,
          `• "Apakah ada user hotspot yang gagal login?"`,
          `• "Cek ping semua router dan 1.1.1.1"`,
          ``,
          `PERINTAH CEPAT:`,
          `• /status — Laporan ringkas semua router live`,
          `• /links — Cek semua link Backbone CRS & vlan2000-CMK`,
          `• /topologi — Cek jalur kabel fiber manual Anda`,
          `• /ping — Cek ping router, vlan2000 & internet`,
          `• /hotspot — Cek user hotspot & gagal login`,
          `• /anomali — Cek semua anomali & mass-disconnect PPPoE`,
          `• /ingat <info> — Ajari SPV NOC fakta/SOP baru permanen`,
        ].join('\n'),
      );
      return;
    }

    if (!this.callbacks.onSpvChat) return;

    let prompt = rawText;
    if (/^\/(status|rekap)\b/i.test(rawText)) {
      prompt = 'SPV NOC, berikan laporan ringkas kondisi semua router live sekarang termasuk CPU, PPPoE, Hotspot, DHCP, link penting, dan Ping.';
    } else if (/^\/links?\b/i.test(rawText)) {
      prompt = 'Cek status seluruh link backbone CRS-BB01..03, suplai ethernet/SFP, serta trafik & ping internet melalui vlan2000-CMK di CORE MONGKONAI sekarang.';
    } else if (/^\/topologi\b/i.test(rawText)) {
      prompt = 'Laporkan peta topologi kabel fiber yang sudah terhubung beserta status dan trafik live tiap jalurnya.';
    } else if (/^\/ping\b/i.test(rawText)) {
      prompt = 'Cek ping semua router live dan internet 1.1.1.1 serta 8.8.8.8 sekarang.';
    } else if (/^\/hotspot\b/i.test(rawText)) {
      prompt = 'Berapa total user hotspot aktif dan apakah ada user hotspot yang gagal login di semua router sekarang?';
    } else if (/^\/anomali\b/i.test(rawText)) {
      prompt = 'Apakah ada anomali, CPU kritis, ping membengkak, atau RADIUS timeout dari laporan agen NOC?';
    }

    // Show live "typing..." indicator in Telegram while SPV NOC prepares answer
    await this.callTelegram('sendChatAction', { chat_id: chatId, action: 'typing' });

    try {
      const result = await this.callbacks.onSpvChat(prompt, actor);
      const cleanReply = sanitizePlainAiText(result.reply);
      const fullText = `${cleanReply}\n\n[${result.source}]`;
      await this.sendLongMessage(chatId, fullText);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Gagal menghubungi SPV NOC';
      await this.sendLongMessage(chatId, `⚠️ Maaf Boss, terjadi kendala saat menghubungi SPV NOC: ${errMsg}`);
    }
  }

  private async handleCallbackQuery(cb: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    if (!cb.data) return;
    const chatId = String(cb.message?.chat?.id ?? '');
    if (!this.isAuthorizedChat(chatId)) {
      await this.callTelegram('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: 'Akses ditolak: Chat ID tidak berwenang.',
        show_alert: true,
      });
      return;
    }

    const actor = `Telegram:${cb.from?.username ?? cb.from?.first_name ?? 'Admin'}`;
    const [verb, ticketId] = cb.data.split(':');
    if (!ticketId) return;

    try {
      if (verb === 'approve') {
        await this.callbacks.onApprove(ticketId, actor);
        await this.callTelegram('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: `Tiket #${ticketId} disetujui & dieksekusi!`,
        });
      } else if (verb === 'reject') {
        await this.callbacks.onReject(ticketId, actor);
        await this.callTelegram('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: `Tiket #${ticketId} ditolak.`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal memproses tiket';
      await this.callTelegram('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: msg.slice(0, 180),
        show_alert: true,
      });
    }
  }

  private async sendLongMessage(chatId: string, text: string): Promise<boolean> {
    const clean = sanitizePlainAiText(text);
    const maxLen = 3900;
    let ok = true;
    for (let i = 0; i < clean.length; i += maxLen) {
      const chunk = clean.slice(i, i + maxLen);
      const res = await this.callTelegram('sendMessage', {
        chat_id: chatId,
        text: chunk,
      });
      if (!res) ok = false;
    }
    return ok;
  }

  private async callTelegram(method: string, body: Record<string, unknown>): Promise<{ result?: unknown } | null> {
    try {
      const url = `https://api.telegram.org/bot${this.token}/${method}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(28_000),
        body: JSON.stringify(body),
      });
      if (!resp.ok) return null;
      return (await resp.json()) as { result?: unknown };
    } catch {
      // Never crash Node process on transient Telegram TLS/network timeout
      return null;
    }
  }
}
