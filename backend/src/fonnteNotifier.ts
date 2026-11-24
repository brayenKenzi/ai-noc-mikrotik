import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AlertSettings } from './types.js';
import { sanitizePlainAiText } from './antigravityBridge.js';

export interface FonnteSendResult {
  readonly ok: boolean;
  readonly detail: string;
}

const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  waEnabled: true,
  waTarget: '',
  dailyReportEnabled: true,
  dailyReportHour: 8,
  pingWarnMs: 50,
  pingCritMs: 100,
  extPingCritMs: 150,
  pingLossCritPct: 40,
  pingConfirmCount: 3,
  alertCooldownSec: 1800, // 30 minutes anti-spam cooldown for repeated critical alerts
};

function localDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * WhatsApp Alert Notifier powered by Fonnte API (https://api.fonnte.com/send)
 * Filtered strictly for:
 *  1) 1x Daily Scheduled Summary Report (default 08:00), and
 *  2) Confirmed CRITICAL-only emergencies (with 30-min anti-spam cooldown + clean recovery).
 */
export class FonnteWhatsappNotifier {
  private readonly token: string;
  private readonly settingsPath: string;
  private settings: AlertSettings;
  private readonly lastSentMap = new Map<string, number>();
  private readonly activeIncidentKeys = new Set<string>();

  constructor(dataDir: string, token: string, defaultTarget: string, envWarnMs?: number, envCritMs?: number) {
    this.token = token.trim();
    this.settingsPath = path.join(dataDir, 'alert-settings.json');
    this.settings = {
      ...DEFAULT_ALERT_SETTINGS,
      waTarget: defaultTarget.trim(),
      ...(envWarnMs ? { pingWarnMs: envWarnMs } : {}),
      ...(envCritMs ? { pingCritMs: envCritMs } : {}),
    };
  }

  get isConfigured(): boolean {
    return this.token.length > 0 && this.settings.waTarget.trim().length > 0;
  }

  get hasToken(): boolean {
    return this.token.length > 0;
  }

  getSettings(): AlertSettings {
    return this.settings;
  }

  hasActiveIncident(incidentKey: string): boolean {
    return this.activeIncidentKeys.has(incidentKey);
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.settingsPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AlertSettings>;
      this.settings = {
        ...DEFAULT_ALERT_SETTINGS,
        ...this.settings,
        ...parsed,
        waTarget: (parsed.waTarget ?? this.settings.waTarget).trim(),
      };
    } catch {
      await this.persist();
    }
  }

  async updateSettings(patch: Partial<AlertSettings>): Promise<AlertSettings> {
    this.settings = {
      ...this.settings,
      ...patch,
      waTarget: patch.waTarget !== undefined ? patch.waTarget.trim() : this.settings.waTarget,
    };
    await this.persist();
    return this.settings;
  }

  shouldSendDailyReport(now = new Date()): boolean {
    if (!this.settings.waEnabled || !this.settings.dailyReportEnabled || !this.isConfigured) {
      return false;
    }
    const today = localDateKey(now);
    if (this.settings.lastDailyReportDate === today) {
      return false;
    }
    return now.getHours() >= this.settings.dailyReportHour;
  }

  async markDailyReportSent(now = new Date()): Promise<void> {
    const today = localDateKey(now);
    if (this.settings.lastDailyReportDate === today) return;
    this.settings = { ...this.settings, lastDailyReportDate: today };
    await this.persist();
  }

  async sendAlertWithCooldown(incidentKey: string, message: string): Promise<boolean> {
    if (!this.settings.waEnabled || !this.isConfigured) {
      return false;
    }
    const now = Date.now();
    const cooldownMs = Math.max(60, this.settings.alertCooldownSec) * 1000;
    const lastSent = this.lastSentMap.get(incidentKey) ?? 0;
    if (now - lastSent < cooldownMs) {
      this.activeIncidentKeys.add(incidentKey);
      return false;
    }
    this.lastSentMap.set(incidentKey, now);
    this.activeIncidentKeys.add(incidentKey);
    const res = await this.sendRaw(this.settings.waTarget, message);
    return res.ok;
  }

  async sendRecoveryIfActive(incidentKey: string, recoveryMessage: string): Promise<boolean> {
    if (!this.activeIncidentKeys.has(incidentKey)) {
      return false;
    }
    this.activeIncidentKeys.delete(incidentKey);
    this.lastSentMap.delete(incidentKey);
    if (!this.settings.waEnabled || !this.isConfigured) {
      return false;
    }
    const res = await this.sendRaw(this.settings.waTarget, recoveryMessage);
    return res.ok;
  }

  async sendTest(targetOverride?: string): Promise<FonnteSendResult> {
    if (!this.token) {
      return { ok: false, detail: 'FONNTE_TOKEN belum dikonfigurasi di server (.env)' };
    }
    const target = (targetOverride ?? this.settings.waTarget).trim();
    if (!target) {
      return { ok: false, detail: 'Nomor WA tujuan belum diisi' };
    }
    const hh = String(this.settings.dailyReportHour).padStart(2, '0');
    const text = [
      `👑 SPV NOC — TES NOTIFIKASI WHATSAPP (MODE ANTI-SPAM)`,
      `Halo Boss! Notifikasi WA kini sudah difilter ketat agar tidak mengganggu:`,
      `• LAPORAN HARIAN: 1x setiap hari pukul ${hh}:00`,
      `• ALERT SEGERA: HANYA gangguan KRITIS terkonfirmasi ${this.settings.pingConfirmCount}x berturut-turut (Router Offline, Ping Router ≥ ${this.settings.pingCritMs}ms / Internet ≥ ${this.settings.extPingCritMs}ms / Loss ≥ ${this.settings.pingLossCritPct}%, RADIUS Timeout, CPU/Suhu Kritis)`,
      `• JEDA ANTI-SPAM: ${Math.round(this.settings.alertCooldownSec / 60)} menit per insiden`,
      `Waktu: ${new Date().toLocaleString('id-ID')}`,
    ].join('\n');
    return this.sendRaw(target, text);
  }

  async sendRaw(target: string, message: string): Promise<FonnteSendResult> {
    if (!this.token || !target.trim()) {
      return { ok: false, detail: 'Token atau target Fonnte kosong' };
    }
    try {
      const cleanMessage = sanitizePlainAiText(message);
      const form = new URLSearchParams();
      form.set('target', target.trim());
      form.set('message', cleanMessage);
      form.set('countryCode', '62');

      const resp = await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: {
          Authorization: this.token,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      const data = (await resp.json().catch(() => ({}))) as { status?: boolean; reason?: string; detail?: string };
      if (!resp.ok || data.status === false) {
        return { ok: false, detail: data.reason ?? data.detail ?? `Fonnte HTTP ${resp.status}` };
      }
      return { ok: true, detail: data.detail ?? 'Pesan WhatsApp terkirim via Fonnte' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'Gagal menghubungi API Fonnte' };
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    const tmp = `${this.settingsPath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.settingsPath);
  }
}
