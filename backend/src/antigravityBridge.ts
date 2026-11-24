import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isRadiusTimeoutMessage, parseRadiusTimeoutUser } from './syslogReceiver.js';
import type {
  AiBridgeState,
  AiChatMessage,
  RouterDevice,
  RouterTelemetry,
  SyslogEntry,
  TelemetryPoint,
} from './types.js';

interface StoredBrainMap {
  [routerId: string]: AiBridgeState;
}

const MAX_MESSAGES_PER_AGENT = 30;

export class AntigravityBridgeStore {
  private states = new Map<string, AiBridgeState>();
  private readonly persistPath: string;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.persistPath = path.join(dataDir, 'ai-bridge.json');
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as StoredBrainMap;
      if (parsed && typeof parsed === 'object') {
        for (const [routerId, state] of Object.entries(parsed)) {
          this.states.set(routerId, state);
        }
      }
    } catch {
      // Seed default Antigravity AI link on Rangga (CCR Momo Net)
      await this.seedDefaultRanggaLink();
      return;
    }

    if (!this.states.has('ccr-momonet-pusat')) {
      await this.seedDefaultRanggaLink();
    }
  }

  private async seedDefaultRanggaLink(): Promise<void> {
    const now = new Date().toISOString();
    const initial: AiBridgeState = {
      linked: true,
      agentLabel: 'Antigravity AI · CCR Specialist',
      lastHeartbeatAt: now,
      lastBriefing: 'Terhubung ke Antigravity AI Bridge — siap memantau & menganalisa CCR-Pusat-MomoNet secara real-time.',
      messages: [
        {
          id: crypto.randomUUID().slice(0, 8),
          role: 'antigravity',
          source: 'Antigravity AI',
          timestamp: now,
          text: '⚡ Koneksi Antigravity AI aktif pada Rangga (CCR-Pusat-MomoNet). Tanyakan kondisi CPU/suhu, trafik OLT/uplink, PPPoE aktif, atau cek log RADIUS kapan saja.',
        },
      ],
    };
    this.states.set('ccr-momonet-pusat', initial);
    await this.persist();
  }

  getState(routerId: string): AiBridgeState | undefined {
    return this.states.get(routerId);
  }

  async recordBridgeReport(
    routerId: string,
    briefing: string,
    detailMessage: string,
    agentLabel = 'Antigravity AI · CCR Specialist',
  ): Promise<AiBridgeState> {
    const now = new Date().toISOString();
    const prev = this.states.get(routerId);
    const msg: AiChatMessage = {
      id: crypto.randomUUID().slice(0, 8),
      role: 'antigravity',
      source: 'Antigravity AI',
      timestamp: now,
      text: detailMessage,
    };
    const next: AiBridgeState = {
      linked: true,
      agentLabel,
      lastHeartbeatAt: now,
      lastBriefing: briefing,
      messages: [...(prev?.messages ?? []), msg].slice(-MAX_MESSAGES_PER_AGENT),
    };
    this.states.set(routerId, next);
    await this.persist();
    return next;
  }

  async appendConversation(
    routerId: string,
    userPrompt: string,
    assistantReply: string,
    source: string,
  ): Promise<AiBridgeState> {
    const now = new Date().toISOString();
    const prev = this.states.get(routerId);
    const userMsg: AiChatMessage = {
      id: crypto.randomUUID().slice(0, 8),
      role: 'user',
      source: 'Admin NOC',
      timestamp: now,
      text: userPrompt,
    };
    const replyMsg: AiChatMessage = {
      id: crypto.randomUUID().slice(0, 8),
      role: 'assistant',
      source,
      timestamp: new Date().toISOString(),
      text: assistantReply,
    };
    const next: AiBridgeState = {
      linked: prev?.linked ?? routerId === 'ccr-momonet-pusat',
      agentLabel: prev?.agentLabel ?? 'Antigravity AI · NOC Assistant',
      lastHeartbeatAt: now,
      lastBriefing: prev?.lastBriefing ?? assistantReply.split('\n')[0]?.slice(0, 140),
      messages: [...(prev?.messages ?? []), userMsg, replyMsg].slice(-MAX_MESSAGES_PER_AGENT),
    };
    this.states.set(routerId, next);
    await this.persist();
    return next;
  }

  private persist(): Promise<void> {
    const obj: StoredBrainMap = {};
    for (const [k, v] of this.states.entries()) {
      obj[k] = v;
    }
    const payload = JSON.stringify(obj, null, 2);
    this.persistChain = this.persistChain
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
        const tmp = `${this.persistPath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
        await fs.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(tmp, this.persistPath);
      });
    return this.persistChain;
  }
}

export async function generateLiveAgentAnswer(options: {
  readonly router: RouterDevice;
  readonly telemetry: RouterTelemetry | null;
  readonly history: readonly TelemetryPoint[];
  readonly recentLogs: readonly SyslogEntry[];
  readonly question: string;
}): Promise<{ readonly reply: string; readonly source: string }> {
  const { router, telemetry, history, recentLogs, question } = options;

  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiKey) {
    try {
      const model = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
      const context = {
        router: {
          name: router.name,
          agentName: router.agentName,
          host: router.host,
          version: router.routerOsVersion,
          simulated: Boolean(router.simulated),
        },
        telemetry,
        recentHistory: history.slice(-10),
        recentLogs: recentLogs.slice(0, 15).map((l) => `[${l.severity}] ${l.message}`),
      };
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: `Kamu adalah ${router.agentName} (terhubung dengan Antigravity AI NOC). Jawab pertanyaan admin dalam Bahasa Indonesia secara ringkas, akurat, teknis, dan berbasis data live JSON berikut. Jangan mengarang angka yang tidak ada di data.`,
              },
            ],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: `Data live router:\n${JSON.stringify(context)}\n\nPertanyaan admin: ${question}` }],
            },
          ],
          generationConfig: { temperature: 0.2 },
        }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) {
          return { reply: text, source: `Antigravity AI (${model})` };
        }
      }
    } catch {
      // Fallback cleanly to deterministic live telemetry reasoning below
    }
  }

  return {
    reply: buildDeterministicLiveReply(router, telemetry, history, recentLogs, question),
    source: 'Antigravity AI · Live Telemetry Engine',
  };
}

export function buildDeterministicLiveReply(
  router: RouterDevice,
  telemetry: RouterTelemetry | null,
  history: readonly TelemetryPoint[],
  recentLogs: readonly SyslogEntry[],
  question: string,
): string {
  const q = question.toLowerCase();

  if (!telemetry) {
    return `Belum ada data telemetri untuk ${router.name} (${router.host}). Klik 🔄 Poll Sekarang untuk menarik data terbaru.`;
  }

  if (!telemetry.reachable) {
    return [
      `⚠️ ${router.name} (${router.host}:${router.port}) saat ini OFFLINE / tidak terjangkau.`,
      telemetry.lastError ? `• Penyebab API: ${telemetry.lastError}` : '',
      `• Saran: pastikan API port ${router.port} aktif, user "${router.readUsername}" & password benar, serta routing dari server NOC terbuka.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  const radiusLogs = recentLogs.filter((l) => isRadiusTimeoutMessage(l.message));
  const errLogs = recentLogs.filter((l) => l.severity === 'critical' || l.severity === 'error' || l.severity === 'warning');
  const topIfaces = telemetry.interfaces.slice(0, 6);
  const downIfaces = telemetry.interfaces.filter((i) => !i.running && !i.disabled);

  // 1. Traffic / OLT / Interface question
  if (/(trafik|traffic|bandwidth|mbps|olt|interface|uplink|port)/i.test(q)) {
    const lines = [
      `🌐 Laporan Trafik Live ${router.name} (${telemetry.boardName}):`,
      ...topIfaces.map(
        (i, idx) => `${idx + 1}. ${i.name}: Rx ${i.rxMbps} Mbps / Tx ${i.txMbps} Mbps (${i.running ? 'UP' : 'DOWN'})`,
      ),
    ];
    if (downIfaces.length > 0) {
      lines.push(`• Port tidak aktif (non-disabled): ${downIfaces.slice(0, 4).map((d) => d.name).join(', ')}`);
    }
    return lines.join('\n');
  }

  // 2. RADIUS / Log / Error question
  if (/(radius|timeout|log|error|alarm|gangguan|insiden)/i.test(q)) {
    if (radiusLogs.length > 0) {
      const users = Array.from(new Set(radiusLogs.map((l) => parseRadiusTimeoutUser(l.message) ?? 'unknown'))).slice(0, 5);
      return [
        `🚨 Terdeteksi ${radiusLogs.length} log RADIUS TIMEOUT pada ${router.name}!`,
        `• User terdampak: ${users.join(', ')}`,
        `• Log terbaru: ${radiusLogs[0]!.message}`,
        `• Tindakan disarankan: cek ping dari ${router.name} ke IP RADIUS server, cek service FreeRADIUS/Userman, dan pastikan UDP 1812/1813 tidak terblokir.`,
      ].join('\n');
    }
    const lines = [
      `✅ Status RADIUS ${router.name}: AMAN (0 radius timeout pada ${recentLogs.length} log terbaru).`,
      errLogs.length > 0
        ? `• Ditemukan ${errLogs.length} log warning/error: ${errLogs[0]!.message}`
        : `• Tidak ada log warning/error kritis. Log terbaru: ${recentLogs[0]?.message ?? 'belum ada log'}`,
    ];
    return lines.join('\n');
  }

  // 3. PPPoE / Subscriber question
  if (/(pppoe|pelanggan|client|user|aktif|sesi)/i.test(q)) {
    const pppIfaces = telemetry.interfaces.filter((i) => i.name.toLowerCase().includes('pppoe') || i.name.toLowerCase().includes('olt'));
    return [
      `👥 Status Pelanggan ${router.name}:`,
      `• Sesi PPPoE Aktif: ${telemetry.activePppoeCount} sesi`,
      ...pppIfaces.slice(0, 4).map((i) => `• ${i.name}: Rx ${i.rxMbps} / Tx ${i.txMbps} Mbps`),
      `• RADIUS Timeout: ${radiusLogs.length} insiden`,
    ].join('\n');
  }

  // 4. CPU / RAM / Temperature / Trend question
  if (/(suhu|temp|panas|cpu|ram|memori|performa)/i.test(q)) {
    const cpus = history.map((h) => h.cpuLoadPercent);
    const maxCpu = cpus.length ? Math.max(...cpus) : telemetry.cpuLoadPercent;
    const avgCpu = cpus.length ? Math.round(cpus.reduce((a, b) => a + b, 0) / cpus.length) : telemetry.cpuLoadPercent;
    const tempNote =
      telemetry.temperatureC === null
        ? 'Sensor suhu tidak dilaporkan board.'
        : telemetry.temperatureC >= 65
          ? `⚠️ Suhu ${telemetry.temperatureC}°C cukup tinggi — cek kipas & sirkulasi rak datacenter!`
          : telemetry.temperatureC >= 55
            ? `ℹ️ Suhu ${telemetry.temperatureC}°C hangat namun masih normal untuk CCR (batas waspada 65°C).`
            : `✅ Suhu ${telemetry.temperatureC}°C sangat dingin & ideal.`;
    return [
      `🌡 Kesehatan Hardware ${router.name} (${telemetry.boardName}):`,
      `• CPU sekarang: ${telemetry.cpuLoadPercent}% (rata-rata ${avgCpu}%, puncak ${maxCpu}% dari ${history.length} sampel)`,
      `• RAM terpakai: ${telemetry.memoryUsedPercent}% · Uptime: ${telemetry.uptime}`,
      `• ${tempNote}`,
    ].join('\n');
  }

  // 5. Default: Complete Executive NOC Briefing
  const topLine = topIfaces[0]
    ? `${topIfaces[0].name} (Rx ${topIfaces[0].rxMbps} / Tx ${topIfaces[0].txMbps} Mbps)`
    : '-';
  const secondOlt = topIfaces.find((i) => i.name.toLowerCase().includes('olt'));
  return [
    `📊 Briefing Live ${router.name} (${telemetry.boardName} · ROS ${telemetry.version}):`,
    `• Status: ${telemetry.status.toUpperCase()} · Uptime ${telemetry.uptime} · Mode ${router.simulated ? 'SIMULASI' : 'LIVE'}`,
    `• Resource: CPU ${telemetry.cpuLoadPercent}% · RAM ${telemetry.memoryUsedPercent}%${telemetry.temperatureC !== null ? ` · Suhu ${telemetry.temperatureC}°C` : ''}`,
    `• PPPoE Aktif: ${telemetry.activePppoeCount} sesi · RADIUS Timeout: ${radiusLogs.length}x`,
    `• Trafik Utama: ${topLine}${secondOlt ? ` | OLT teratas: ${secondOlt.name} (Tx ${secondOlt.txMbps} Mbps)` : ''}`,
    telemetry.temperatureC !== null && telemetry.temperatureC >= 55
      ? `• Catatan NOC: Suhu ${telemetry.temperatureC}°C terpantau hangat — pastikan airflow rak CCR lancar.`
      : `• Catatan NOC: Seluruh parameter berjalan normal.`,
  ].join('\n');
}
