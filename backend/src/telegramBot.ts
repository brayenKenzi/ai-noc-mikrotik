import type { ApprovalTicket } from './types.js';

export interface TelegramBotCallbacks {
  readonly onApprove: (ticketId: string, actor: string) => Promise<ApprovalTicket>;
  readonly onReject: (ticketId: string, actor: string) => Promise<ApprovalTicket>;
}

/**
 * Lightweight Telegram Bot integration using native HTTPS fetch (Long Polling).
 * Sends interactive Inline Keyboard [✅ Setujui Eksekusi] [❌ Tolak] cards to the NOC Admin chat.
 */
export class TelegramNocBot {
  private readonly token: string;
  private readonly allowedChatId: string;
  private readonly callbacks: TelegramBotCallbacks;
  private running = false;
  private updateOffset = 0;

  constructor(token: string, allowedChatId: string, callbacks: TelegramBotCallbacks) {
    this.token = token.trim();
    this.allowedChatId = allowedChatId.trim();
    this.callbacks = callbacks;
  }

  get isEnabled(): boolean {
    return this.token.length > 0 && this.allowedChatId.length > 0;
  }

  start(): void {
    if (!this.isEnabled || this.running) return;
    this.running = true;
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
  }

  async sendApprovalRequestCard(ticket: ApprovalTicket): Promise<void> {
    if (!this.isEnabled) return;

    const text = [
      `🚨 *AI NOC — Menunggu Persetujuan Tindakan*`,
      `• *Tiket:* \`#${ticket.id}\``,
      `• *Router:* *${escapeMd(ticket.routerName)}*`,
      `• *Agen:* ${escapeMd(ticket.agentName)}`,
      `• *Tingkat Risiko:* \`${ticket.proposal.riskLevel}\``,
      ``,
      `*Insiden:* ${escapeMd(ticket.incidentSummary)}`,
      `*Analisis:* ${escapeMd(ticket.rootCauseAnalysis)}`,
      ``,
      `*Perintah MikroTik yang Diusulkan:*`,
      `\`${escapeMd(ticket.proposal.previewCommand)}\``,
      ``,
      `*Rencana Rollback:*`,
      `\`${escapeMd(ticket.proposal.rollbackCommand)}\``,
    ].join('\n');

    await this.callTelegram('sendMessage', {
      chat_id: this.allowedChatId,
      text,
      parse_mode: 'Markdown',
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
    const text = [
      `${icon} *Update Tiket #${ticket.id}* (${ticket.routerName})`,
      `Status: *${ticket.status}* oleh ${escapeMd(ticket.decidedBy ?? 'Admin')}`,
      ticket.executionResult ? `Hasil: \`${escapeMd(ticket.executionResult)}\`` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await this.callTelegram('sendMessage', {
      chat_id: this.allowedChatId,
      text,
      parse_mode: 'Markdown',
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const res = await this.callTelegram('getUpdates', {
          offset: this.updateOffset,
          timeout: 20,
          allowed_updates: ['callback_query'],
        });

        const updates = (res?.result ?? []) as {
          update_id: number;
          callback_query?: {
            id: string;
            from?: { username?: string; first_name?: string };
            message?: { chat?: { id?: number | string } };
            data?: string;
          };
        }[];

        for (const u of updates) {
          this.updateOffset = u.update_id + 1;
          const cb = u.callback_query;
          if (!cb?.data) continue;

          const chatId = String(cb.message?.chat?.id ?? '');
          if (chatId !== this.allowedChatId) {
            await this.callTelegram('answerCallbackQuery', {
              callback_query_id: cb.id,
              text: 'Akses ditolak: Chat ID tidak berwenang.',
              show_alert: true,
            });
            continue;
          }

          const actor = `Telegram:${cb.from?.username ?? cb.from?.first_name ?? 'Admin'}`;
          const [verb, ticketId] = cb.data.split(':');
          if (!ticketId) continue;

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
      } catch {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async callTelegram(method: string, body: Record<string, unknown>): Promise<{ result?: unknown } | null> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as { result?: unknown };
  }
}

function escapeMd(s: string): string {
  return s.replace(/([_*`\[])/g, ' ');
}
