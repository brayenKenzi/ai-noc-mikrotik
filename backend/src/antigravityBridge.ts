import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isRadiusTimeoutMessage, parseHotspotFailedLogin, parseRadiusTimeoutUser } from './syslogReceiver.js';
import { detectTeachingFact, type StoredMemoryTurn } from './aiMemoryStore.js';
import type {
  AiBridgeState,
  AiChatMessage,
  AiLearnedFact,
  ApprovalTicket,
  LiveTopologyLink,
  OfficeAgentView,
  PingMetric,
  RouterDevice,
  RouterTelemetry,
  SpvReportEntry,
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

    if (!this.states.has('spv-noc')) {
      await this.seedDefaultSpvNoc();
    }
    if (!this.states.has('ccr-momonet-pusat')) {
      await this.seedDefaultRanggaLink();
    }
  }

  private async seedDefaultSpvNoc(): Promise<void> {
    const now = new Date().toISOString();
    const initial: AiBridgeState = {
      linked: true,
      agentLabel: 'SPV NOC · AI Supervisor (Semua Router)',
      lastHeartbeatAt: now,
      lastBriefing:
        'SPV NOC aktif mengawasi seluruh agen NOC & router MikroTik secara real-time, terhubung ke Telegram Live Chat & WhatsApp Fonnte.',
      messages: [
        {
          id: crypto.randomUUID().slice(0, 8),
          role: 'antigravity',
          source: 'SPV NOC · AI Supervisor',
          timestamp: now,
          text: '👑 Halo Boss! Saya SPV NOC, 1 AI Supervisor terpusat yang terhubung ke seluruh router MikroTik, menerima laporan real-time dari semua agen NOC, serta terhubung ke Live Chat Telegram & notifikasi WA Fonnte. Tanyakan kondisi seluruh jaringan, user Hotspot/PPPoE, trafik tertinggi, log gagal login, atau status Ping kapan saja!',
        },
      ],
    };
    this.states.set('spv-noc', initial);
    await this.persist();
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
    userSource = 'Admin NOC',
  ): Promise<AiBridgeState> {
    const now = new Date().toISOString();
    const prev = this.states.get(routerId);
    const userMsg: AiChatMessage = {
      id: crypto.randomUUID().slice(0, 8),
      role: 'user',
      source: userSource,
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

/**
 * Converts Markdown-heavy LLM replies into clean, human-readable plain text with ZERO asterisks (*).
 * Bold phrases (**text**) and markdown headings (### title) are promoted to UPPERCASE for clear visual hierarchy.
 */
export function sanitizePlainAiText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    // Convert markdown headings (# Title) into clean UPPERCASE section headers
    .replace(/^\s*#{1,6}\s+(.+)$/gm, (_m, heading: string) => heading.replace(/\*/g, '').trim().toUpperCase())
    // Convert **bold text** into UPPERCASE (no asterisks!)
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) => inner.trim().toUpperCase())
    // Convert __bold text__ into UPPERCASE
    .replace(/__([^_\n]+)__/g, (_m, inner: string) => inner.trim().toUpperCase())
    // Convert markdown list bullets (* item or - item) into clean bullet dots
    .replace(/^\s*\*\s+/gm, '• ')
    // Strip italic *text* into plain text
    .replace(/\*([^*\n]+)\*/g, '$1')
    // Strip inline code backticks (`text`) cleanly
    .replace(/`([^`\n]+)`/g, '$1')
    // Final guarantee: zero stray asterisks remain anywhere
    .replace(/\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function getGeminiModelCandidates(): readonly string[] {
  const configured = process.env.GEMINI_MODEL?.trim();
  const candidates = [
    configured || 'gemini-flash-lite-latest',
    'gemini-flash-lite-latest',
    'gemini-3-flash-preview',
    'gemini-flash-latest',
  ];
  return Array.from(new Set(candidates.filter(Boolean)));
}

export async function generateLiveAgentAnswer(options: {
  readonly router: RouterDevice;
  readonly telemetry: RouterTelemetry | null;
  readonly history: readonly TelemetryPoint[];
  readonly recentLogs: readonly SyslogEntry[];
  readonly externalPings?: readonly PingMetric[];
  readonly question: string;
}): Promise<{ readonly reply: string; readonly source: string }> {
  const { router, telemetry, history, recentLogs, externalPings = [], question } = options;

  const hotspotFailures = recentLogs
    .map((l) => ({ log: l, username: parseHotspotFailedLogin(l) }))
    .filter((x): x is { log: SyslogEntry; username: string } => x.username !== null);
  const radiusLogs = recentLogs.filter((l) => isRadiusTimeoutMessage(l.message));

  const context = {
    router: {
      name: router.name,
      agentName: router.agentName,
      host: router.host,
      port: router.port,
      version: router.routerOsVersion,
      simulated: Boolean(router.simulated),
    },
    telemetry,
    hotspotSummary: {
      activeHotspotUsers: telemetry?.activeHotspotCount ?? 0,
      hotspotHosts: telemetry?.hotspotHostCount ?? 0,
      dhcpLeases: telemetry?.dhcpLeaseCount ?? 0,
      failedLoginCountInLogs: hotspotFailures.length,
      failedUsers: Array.from(new Set(hotspotFailures.map((x) => x.username))).slice(0, 10),
      failedLogSamples: hotspotFailures.slice(0, 8).map((x) => x.log.message),
    },
    radiusSummary: {
      timeoutCount: radiusLogs.length,
      timeoutSamples: radiusLogs.slice(0, 6).map((l) => l.message),
    },
    externalInternetPings: externalPings,
    recentHistory: history.slice(-10),
    recentLogs: recentLogs.slice(0, 25).map((l) => `[${l.severity}][${l.topics.join(',')}] ${l.message}`),
  };

  const systemPrompt = [
    `Kamu adalah ${router.agentName}, Senior Network Operations Center (NOC) AI Engineer untuk router MikroTik "${router.name}" (${router.host}).`,
    `Jawab pertanyaan admin dalam Bahasa Indonesia secara natural, cerdas, ringkas, akurat, dan 100% berbasis data live JSON yang diberikan.`,
    `Aturan penting:`,
    `1. Bedakan dengan jelas antara PPPoE Aktif (activePppoeCount), Hotspot Aktif (activeHotspotCount), Hotspot Host (hotspotHostCount), dan DHCP Lease (dhcpLeaseCount).`,
    `2. Jika ditanya user hotspot yang gagal login, lihat hotspotSummary.failedLoginCountInLogs, failedUsers, dan recentLogs. Jika 0, katakan dengan jelas belum ada log gagal login hotspot yang tercatat saat ini.`,
    `3. Jika ditanya ping / latensi / internet lemot, laporkan telemetry.ping (ping ke router) DAN externalInternetPings (1.1.1.1, 8.8.8.8).`,
    `4. JANGAN PERNAH mengarang angka yang tidak ada di JSON. Jika data kosong atau router simulasi, sebutkan dengan jujur.`,
    `5. FORMAT TEKS WAJIB: DILARANG menggunakan tanda bintang (* atau **), tanda pagar (#), atau backtick (\`). Gunakan HURUF KAPITAL untuk judul/penekanan penting dan simbol • untuk daftar poin agar bersih dibaca.`,
  ].join('\n');

  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiKey) {
    for (const model of getGeminiModelCandidates()) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [
              {
                role: 'user',
                parts: [{ text: `Data live router (JSON):\n${JSON.stringify(context)}\n\nPertanyaan admin: ${question}` }],
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
            return { reply: sanitizePlainAiText(text), source: `Gemini Cloud AI (${model})` };
          }
        }
      } catch {
        // Try next Gemini model in fallback chain
      }
    }
  }

  const openaiKey = process.env.LLM_API_KEY?.trim();
  if (openaiKey) {
    try {
      const baseUrl = (process.env.LLM_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const model = process.env.LLM_MODEL?.trim() || 'gpt-4o-mini';
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`,
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Data live router (JSON):\n${JSON.stringify(context)}\n\nPertanyaan admin: ${question}` },
          ],
        }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) {
          return { reply: sanitizePlainAiText(text), source: `Cloud AI (${model})` };
        }
      }
    } catch {
      // Fallback cleanly to deterministic live telemetry reasoning below
    }
  }

  return {
    reply: sanitizePlainAiText(buildDeterministicLiveReply(router, telemetry, history, recentLogs, question, externalPings)),
    source: 'Antigravity AI · Local Telemetry Engine',
  };
}

export function buildDeterministicLiveReply(
  router: RouterDevice,
  telemetry: RouterTelemetry | null,
  history: readonly TelemetryPoint[],
  recentLogs: readonly SyslogEntry[],
  question: string,
  externalPings: readonly PingMetric[] = [],
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
  const hotspotFailures = recentLogs
    .map((l) => ({ log: l, username: parseHotspotFailedLogin(l) }))
    .filter((x): x is { log: SyslogEntry; username: string } => x.username !== null);
  const errLogs = recentLogs.filter((l) => l.severity === 'critical' || l.severity === 'error' || l.severity === 'warning');
  const topIfaces = telemetry.interfaces.slice(0, 6);
  const downIfaces = telemetry.interfaces.filter((i) => !i.running && !i.disabled);

  // 1. Hotspot & Failed Login question (MUST come before RADIUS/log and PPPoE!)
  if (/(hotspot|voucher|gagal\s*login|tidak\s+bisa\s+login|bisa\s+login|login\s*failed)/i.test(q)) {
    const failedUsers = Array.from(new Set(hotspotFailures.map((x) => x.username))).slice(0, 8);
    const lines = [
      `📶 Status Hotspot ${router.name} (${telemetry.boardName}):`,
      `• User Hotspot Aktif: ${telemetry.activeHotspotCount} user | Host terdeteksi: ${telemetry.hotspotHostCount} | DHCP Lease: ${telemetry.dhcpLeaseCount}`,
      `• Gagal Login Hotspot di Log: ${hotspotFailures.length} kejadian${failedUsers.length > 0 ? ` (user: ${failedUsers.join(', ')})` : ' (aman, belum ada log gagal login hotspot saat ini)'}`,
    ];
    if (hotspotFailures[0]) {
      lines.push(`• Log gagal login terbaru: ${hotspotFailures[0].log.message}`);
    }
    if (radiusLogs.length > 0) {
      lines.push(`• ⚠️ Catatan RADIUS: ${radiusLogs.length}x RADIUS timeout terdeteksi yang bisa menyebabkan user tidak bisa login!`);
    }
    return lines.join('\n');
  }

  // 2. Ping / Latency / Internet Health question
  if (/(ping|latensi|latency|rto|loss|lag|lambat|lemot|jitter)/i.test(q)) {
    const lines = [`📡 Status Ping & Latensi Live (${router.name}):`];
    if (telemetry.ping) {
      const p = telemetry.ping;
      lines.push(
        `• Router ${router.name} (${p.target}): ${p.avgMs !== null ? `avg ${p.avgMs} ms (min ${p.minMs} / max ${p.maxMs} ms)` : 'RTO / DOWN'} · Loss ${p.packetLossPercent}% [${p.status.toUpperCase()}]`,
      );
    } else {
      lines.push(`• Router ${router.name}: ping pertama sedang berjalan…`);
    }
    for (const ep of externalPings) {
      lines.push(
        `• Internet ${ep.label} (${ep.target}): ${ep.avgMs !== null ? `avg ${ep.avgMs} ms (max ${ep.maxMs} ms)` : 'RTO / DOWN'} · Loss ${ep.packetLossPercent}% [${ep.status.toUpperCase()}]`,
      );
    }
    return lines.join('\n');
  }

  // 3. Traffic / OLT / Interface question
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

  // 4. RADIUS / Log / Error question (word boundary \blog\b so "login" NEVER triggers this!)
  if (/(radius|timeout|\blog\b|\blogs\b|error|alarm|gangguan|insiden)/i.test(q)) {
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

  // 5. PPPoE / Subscriber question
  if (/(pppoe|pelanggan|client|user|aktif|sesi|dhcp)/i.test(q)) {
    const pppIfaces = telemetry.interfaces.filter((i) => i.name.toLowerCase().includes('pppoe') || i.name.toLowerCase().includes('olt'));
    return [
      `👥 Status Pelanggan ${router.name}:`,
      `• Sesi PPPoE Aktif: ${telemetry.activePppoeCount} sesi`,
      `• User Hotspot Aktif: ${telemetry.activeHotspotCount} user (Host: ${telemetry.hotspotHostCount}) · DHCP Lease: ${telemetry.dhcpLeaseCount}`,
      ...pppIfaces.slice(0, 4).map((i) => `• ${i.name}: Rx ${i.rxMbps} / Tx ${i.txMbps} Mbps`),
      `• Gagal Login Hotspot: ${hotspotFailures.length}x · RADIUS Timeout: ${radiusLogs.length}x`,
    ].join('\n');
  }

  // 6. CPU / RAM / Temperature / Trend question
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

  // 7. Default: Complete Executive NOC Briefing
  const topLine = topIfaces[0]
    ? `${topIfaces[0].name} (Rx ${topIfaces[0].rxMbps} / Tx ${topIfaces[0].txMbps} Mbps)`
    : '-';
  const secondOlt = topIfaces.find((i) => i.name.toLowerCase().includes('olt'));
  const pingStr = telemetry.ping
    ? telemetry.ping.avgMs !== null
      ? `${telemetry.ping.avgMs} ms (loss ${telemetry.ping.packetLossPercent}%)`
      : 'RTO/DOWN'
    : '-';
  return [
    `📊 Briefing Live ${router.name} (${telemetry.boardName} · ROS ${telemetry.version}):`,
    `• Status: ${telemetry.status.toUpperCase()} · Uptime ${telemetry.uptime} · Ping ${pingStr} · Mode ${router.simulated ? 'SIMULASI' : 'LIVE'}`,
    `• Resource: CPU ${telemetry.cpuLoadPercent}% · RAM ${telemetry.memoryUsedPercent}%${telemetry.temperatureC !== null ? ` · Suhu ${telemetry.temperatureC}°C` : ''}`,
    `• Pelanggan: PPPoE ${telemetry.activePppoeCount} aktif · Hotspot ${telemetry.activeHotspotCount} aktif (Host ${telemetry.hotspotHostCount}) · DHCP ${telemetry.dhcpLeaseCount}`,
    `• Log Alert: RADIUS Timeout ${radiusLogs.length}x · Gagal Login Hotspot ${hotspotFailures.length}x`,
    `• Trafik Utama: ${topLine}${secondOlt ? ` | OLT teratas: ${secondOlt.name} (Tx ${secondOlt.txMbps} Mbps)` : ''}`,
    telemetry.temperatureC !== null && telemetry.temperatureC >= 55
      ? `• Catatan NOC: Suhu ${telemetry.temperatureC}°C terpantau hangat — pastikan airflow rak CCR lancar.`
      : `• Catatan NOC: Seluruh parameter berjalan normal.`,
  ].join('\n');
}

/**
 * Centralized 1-AI Supervisor ("SPV NOC") with full real-time visibility across ALL MikroTik routers,
 * all NOC agent reports, Hotspot/PPPoE/DHCP stats, Ping metrics, and pending approvals.
 */
export interface SpvMemoryRetrieval {
  readonly relevantFacts: readonly AiLearnedFact[];
  readonly relevantTurns: readonly StoredMemoryTurn[];
  readonly recentTurns: readonly StoredMemoryTurn[];
}

export async function generateSpvFleetAnswer(options: {
  readonly agents: readonly OfficeAgentView[];
  readonly externalPings: readonly PingMetric[];
  readonly reports: readonly SpvReportEntry[];
  readonly pendingApprovals: readonly ApprovalTicket[];
  readonly topologyLinks?: readonly LiveTopologyLink[];
  readonly memoryContext?: SpvMemoryRetrieval;
  readonly question: string;
  readonly focusRouterId?: string;
}): Promise<{ readonly reply: string; readonly source: string }> {
  const {
    agents,
    externalPings,
    reports,
    pendingApprovals,
    topologyLinks = [],
    memoryContext,
    question,
    focusRouterId,
  } = options;

  const taughtFact = detectTeachingFact(question);

  const fleetContext = {
    supervisor: 'SPV NOC (AI Supervisor Terpusat)',
    focusRouterId: focusRouterId ?? null,
    justTaughtNewFact: taughtFact ?? null,
    summary: {
      totalRouters: agents.length,
      liveRouters: agents.filter((a) => !a.routerConfig.simulated).length,
      onlineRouters: agents.filter((a) => a.telemetry?.reachable).length,
      totalPppoeActive: agents.reduce((acc, a) => acc + (a.telemetry?.activePppoeCount ?? 0), 0),
      totalHotspotActive: agents.reduce((acc, a) => acc + (a.telemetry?.activeHotspotCount ?? 0), 0),
      totalHotspotHosts: agents.reduce((acc, a) => acc + (a.telemetry?.hotspotHostCount ?? 0), 0),
      totalDhcpLeases: agents.reduce((acc, a) => acc + (a.telemetry?.dhcpLeaseCount ?? 0), 0),
      totalRadiusTimeouts: agents.reduce((acc, a) => acc + a.radiusTimeoutCount, 0),
      totalHotspotFailedLogins: agents.reduce((acc, a) => acc + a.hotspotFailedLoginCount, 0),
      pendingApprovalsCount: pendingApprovals.length,
      fiberTopologyCableCount: topologyLinks.length,
    },
    externalInternetPings: externalPings,
    fiberTopologyMap: topologyLinks.map((l) => ({
      route: `${l.fromRouterName} (${l.fromInterface || 'port'}) -> ${l.toRouterName} (${l.toInterface || 'port'})`,
      label: l.label,
      type: l.fiberType,
      status: l.status,
      liveMbps: l.liveMbps,
      reason: l.statusReason,
    })),
    longTermMemory: memoryContext
      ? {
          learnedFactsFromAdmin: memoryContext.relevantFacts.map((f) => `[${f.topic}] ${f.text}`),
          relevantPastChats: memoryContext.relevantTurns.map((t) => ({
            q: t.question.slice(0, 140),
            a: t.reply.slice(0, 220),
          })),
          recentConversationHistory: memoryContext.recentTurns.map((t) => ({
            q: t.question.slice(0, 140),
            a: t.reply.slice(0, 220),
          })),
        }
      : null,
    routers: agents.map((a) => ({
      routerId: a.routerId,
      routerName: a.routerConfig.name,
      agentOperator: a.nama,
      dutyRole: a.routerConfig.dutyRole,
      dutyLabel: a.routerConfig.dutyLabel,
      customPromptSop: a.routerConfig.customPrompt || undefined,
      host: a.routerConfig.host,
      mode: a.routerConfig.simulated ? 'SIMULASI' : 'LIVE',
      rosVersion: a.telemetry?.version ?? a.routerConfig.routerOsVersion,
      board: a.telemetry?.boardName ?? a.routerConfig.deviceModel,
      reachable: a.telemetry?.reachable ?? false,
      status: a.telemetry?.status ?? 'offline',
      uptime: a.telemetry?.uptime ?? '-',
      cpuPct: a.telemetry?.cpuLoadPercent ?? 0,
      ramPct: a.telemetry?.memoryUsedPercent ?? 0,
      tempC: a.telemetry?.temperatureC ?? null,
      pppoeActive: a.telemetry?.activePppoeCount ?? 0,
      pppoeMassDrop: a.telemetry?.pppoeDrop ?? null,
      hotspotActive: a.telemetry?.activeHotspotCount ?? 0,
      hotspotHosts: a.telemetry?.hotspotHostCount ?? 0,
      dhcpLeases: a.telemetry?.dhcpLeaseCount ?? 0,
      ping: a.telemetry?.ping ?? null,
      interfacePing: a.telemetry?.interfacePingResult ?? null,
      watchedLinks: a.telemetry?.watchedLinks ?? [],
      sfpOptics: (a.telemetry?.sfpOptics ?? [])
        .filter((s) => s.health !== 'empty')
        .map((s) => ({
          port: s.name,
          rxDbm: s.rxPowerDbm,
          txDbm: s.txPowerDbm,
          tempC: s.temperatureC,
          health: s.health,
          vendor: s.vendor,
        })),
      radiusTimeoutCount: a.radiusTimeoutCount,
      hotspotFailedLoginCount: a.hotspotFailedLoginCount,
      hotspotFailedUsers: a.hotspotFailedUsers,
      urgentAlerts: a.mendesak,
      topInterfaces: (a.telemetry?.interfaces ?? []).slice(0, 4).map((i) => ({
        name: i.name,
        up: i.running,
        rx: i.rxMbps,
        tx: i.txMbps,
      })),
      recentNotableLogs: a.recentLogs
        .filter((l) => l.severity !== 'info')
        .slice(0, 4)
        .map((l) => `[${l.severity}] ${l.message.slice(0, 100)}`),
    })),
    recentAgentReportsToSpv: reports.slice(0, 8).map((r) => ({
      time: r.timestamp,
      fromAgent: r.agentName,
      router: r.routerName,
      category: r.category,
      severity: r.severity,
      message: r.message,
      sentToWa: r.sentToWa,
    })),
  };

  const systemPrompt = [
    `Kamu adalah SPV NOC, 1 AI Supervisor NOC terpusat yang mengawasi seluruh agen NOC dan terhubung ke SEMUA router MikroTik di Cafe Datacenter NOC.`,
    `Jawab pertanyaan owner/admin dalam Bahasa Indonesia secara tegas, ramah, cerdas, ringkas, rapi, dan 100% berbasis data live JSON seluruh router berikut.`,
    `Aturan wajib:`,
    `1. Prioritaskan data router berstatus mode LIVE saat melaporkan angka nyata, dan sebutkan dengan jelas jika suatu router masih mode SIMULASI.`,
    `2. Bedakan jelas antara PPPoE Aktif, Mass-Disconnect PPPoE (OLT/FO putus), Hotspot Aktif, Host Hotspot, DHCP Lease, dan Gagal Login Hotspot.`,
    `3. Gunakan fiberTopologyMap untuk menjelaskan rute kabel FO antar perangkat (dari port mana ke router mana & status live Mbps-nya).`,
    `4. Gunakan longTermMemory (learnedFactsFromAdmin dan relevantPastChats) agar kamu mengingat semua pelajaran, SOP, dan diskusi lama dengan admin. Jika justTaughtNewFact terisi, konfirmasi bahwa ilmu/info baru itu sudah tersimpan permanen di memori SPV NOC.`,
    `5. Jika ditanya ping/latensi, tampilkan ping tiap router LIVE + ping interface khusus (seperti vlan2000-CMK ke 1.1.1.1 di CORE MONGKONAI) + ping internet (1.1.1.1 & 8.8.8.8).`,
    `6. Perhatikan dutyRole, watchedLinks, dan customPromptSop dari setiap agen.`,
    `7. JANGAN PERNAH mengarang angka di luar JSON.`,
    `8. FORMAT WAJIB TANPA MARKDOWN: DILARANG KERAS memakai tanda bintang (* atau **), pagar (#), atau backtick (\`). Gunakan HURUF KAPITAL untuk judul/penekanan penting dan simbol • untuk poin agar mudah dibaca di Web dan Telegram.`,
  ].join('\n');

  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiKey) {
    for (const model of getGeminiModelCandidates()) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(18_000),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: `Data Live Seluruh Fleet MikroTik (JSON):\n${JSON.stringify(fleetContext)}\n\nPertanyaan Owner/Admin: ${question}`,
                  },
                ],
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
            return { reply: sanitizePlainAiText(text), source: `SPV NOC · Gemini AI (${model})` };
          }
        }
      } catch {
        // Fallback to next Gemini model
      }
    }
  }

  return {
    reply: sanitizePlainAiText(
      buildDeterministicSpvReply(agents, externalPings, reports, question, focusRouterId, topologyLinks, memoryContext),
    ),
    source: 'SPV NOC · Local Fleet Engine',
  };
}

export function buildDeterministicSpvReply(
  agents: readonly OfficeAgentView[],
  externalPings: readonly PingMetric[],
  reports: readonly SpvReportEntry[],
  question: string,
  focusRouterId?: string,
  topologyLinks: readonly LiveTopologyLink[] = [],
  memoryContext?: SpvMemoryRetrieval,
): string {
  const q = question.toLowerCase();
  const liveAgents = agents.filter((a) => !a.routerConfig.simulated);
  const scope = liveAgents.length > 0 ? liveAgents : agents;

  const taughtFact = detectTeachingFact(question);
  if (taughtFact) {
    return [
      `🧠 SIAP BOSS! MEMORI BARU SUDAH DIPELAJARI & DISIMPAN PERMANEN:`,
      `• "${taughtFact}"`,
      `• Mulai sekarang baik AI Lokal maupun Gemini SPV NOC akan selalu mengingat informasi ini saat menganalisa jaringan Anda.`,
    ].join('\n');
  }

  // Helper to attach relevant learned facts from Long-Term AI Memory so Local AI truly learns too!
  const memoryFooter = (): string => {
    const facts = memoryContext?.relevantFacts ?? [];
    if (facts.length === 0) return '';
    return `\n\n🧠 CATATAN MEMORI YANG SUDAH DIPELAJARI:\n${facts
      .slice(0, 3)
      .map((f) => `• ${f.text}`)
      .join('\n')}`;
  };

  // Check if user mentioned a specific router
  const matchedRouter =
    (focusRouterId ? agents.find((a) => a.routerId === focusRouterId) : undefined) ??
    agents.find(
      (a) =>
        q.includes(a.routerConfig.name.toLowerCase()) ||
        q.includes(a.routerId.toLowerCase()) ||
        q.includes((a.nama.split(' ')[0] ?? '').toLowerCase()),
    );

  // If user asks for a complete multi-metric summary across all routers, return full executive fleet report
  const wantsFullFleet =
    /(rekap|ringkas|analisa lengkap|kondisi semua|laporan semua)/i.test(q) &&
    !/(gagal\s*login|tidak\s+bisa\s+login)/i.test(q);

  // 1. Fiber Topology & Cable Route question
  if (!wantsFullFleet && /(topologi|kabel|jalur\s*fo|fiber|rute|sambungan|lewat\s*mana)/i.test(q)) {
    if (topologyLinks.length === 0) {
      return `🗺 PETA TOPOLOGI FIBER: Belum ada kabel fiber yang ditarik manual. Buka menu 🗺 Topologi FO di Dashboard Web untuk menarik kabel antar router agar SPV NOC mengetahui jalur fisik jaringan Anda.${memoryFooter()}`;
    }
    const lines = [
      `🗺 LAPORAN SPV NOC — PETA TOPOLOGI KABEL FIBER (${topologyLinks.length} JALUR):`,
      ...topologyLinks.map(
        (l) =>
          `• [${l.status.toUpperCase()}] ${l.fromRouterName} (${l.fromInterface || 'port'}) ──▶ ${l.toRouterName} (${l.toInterface || 'port'}) · ${l.label} · ${l.liveMbps} Mbps (${l.statusReason})`,
      ),
    ];
    return `${lines.join('\n')}${memoryFooter()}`;
  }

  // 1b. SFP Optical RX/TX Power (dBm) question
  if (!wantsFullFleet && /(sfp|redaman|optik|dbm|laser|transceiver)/i.test(q)) {
    const sfpLines: string[] = [];
    for (const a of scope) {
      const activeSfps = (a.telemetry?.sfpOptics ?? []).filter((s) => s.health !== 'empty');
      for (const s of activeSfps) {
        const tag = s.health === 'critical' ? 'KRITIS' : s.health === 'warning' ? 'RAWAN' : 'NORMAL';
        sfpLines.push(
          `• [${tag}] ${a.routerConfig.name} -> ${s.name}: RX ${s.rxPowerDbm ?? '-'} dBm · TX ${s.txPowerDbm ?? '-'} dBm${s.temperatureC !== null ? ` · Suhu ${s.temperatureC}°C` : ''}${s.vendor ? ` (${s.vendor})` : ''}`,
        );
      }
    }
    if (sfpLines.length === 0) {
      return `🌅 SENSOR REDAMAN SFP OPTIK: Belum ada modul SFP aktif yang melaporkan daya dBm pada router live saat ini.${memoryFooter()}`;
    }
    return [`🌅 LAPORAN SPV NOC — REDAMAN MODUL SFP OPTIK (${sfpLines.length} PORT AKTIF):`, ...sfpLines].join('\n') + memoryFooter();
  }

  // 2. Mass-Disconnect PPPoE / OLT Cut question
  if (!wantsFullFleet && /(mass.?disconnect|putus\s*massal|olt\s*putus|pppoe\s*putus|pppoe\s*drop)/i.test(q)) {
    const activeDrops = agents.filter((a) => a.telemetry?.pppoeDrop?.activeIncident);
    if (activeDrops.length > 0) {
      const lines = [
        `🚨 TERDETEKSI MASS-DISCONNECT PPPOE:`,
        ...activeDrops.map((a) => {
          const d = a.telemetry!.pppoeDrop!;
          return `• ${a.routerConfig.name}: ${d.droppedCount} user putus (${d.previousPeak} → ${d.currentCount}, -${d.droppedPercent}%)${d.suspectedOltInterfaces.length ? ` · OLT/Port: ${d.suspectedOltInterfaces.join(', ')}` : ''}`;
        }),
      ];
      return `${lines.join('\n')}${memoryFooter()}`;
    }
    const totalPpp = scope.reduce((s, a) => s + (a.telemetry?.activePppoeCount ?? 0), 0);
    return `✅ STATUS MASS-DISCONNECT PPPOE: AMAN (tidak ada pemutusan massal OLT/FO saat ini). Total PPPoE aktif di ${scope.length} router live: ${totalPpp} sesi.${memoryFooter()}`;
  }

  // 3. Learned Memory / Knowledge recall question
  if (!wantsFullFleet && /(memori|ingatan|sudah\s*dipelajari|catat|fakta)/i.test(q)) {
    const facts = memoryContext?.relevantFacts ?? [];
    if (facts.length === 0) {
      return `🧠 MEMORI AI SPV NOC: Belum ada catatan khusus yang tersimpan. Anda bisa mengajariku langsung lewat chat dengan mengetik "Ingat ya: ..." atau lewat tombol 🧠 Memori AI di Dashboard!`;
    }
    return [
      `🧠 PENGETAHUAN & SOP YANG SUDAH DIPELAJARI SPV NOC (${facts.length} CATATAN):`,
      ...facts.map((f, idx) => `${idx + 1}. [${f.topic.toUpperCase()}] ${f.text}`),
    ].join('\n');
  }

  if (!wantsFullFleet && /(hotspot|voucher|gagal\s*login|tidak\s+bisa\s+login|bisa\s+login)/i.test(q)) {
    const list = matchedRouter ? [matchedRouter] : scope;
    const totalHs = list.reduce((s, a) => s + (a.telemetry?.activeHotspotCount ?? 0), 0);
    const totalFail = list.reduce((s, a) => s + a.hotspotFailedLoginCount, 0);
    const lines = [
      `👑 Laporan SPV NOC — Monitoring Hotspot (${list.length} router):`,
      `• Total Hotspot Aktif: ${totalHs} user | Total Gagal Login di Log: ${totalFail} kejadian`,
      ...list.map((a) => {
        const t = a.telemetry;
        const users = a.hotspotFailedUsers.length ? ` (user: ${a.hotspotFailedUsers.slice(0, 4).join(', ')})` : '';
        return `• ${a.routerConfig.name}: ${t?.activeHotspotCount ?? 0} aktif · ${t?.hotspotHostCount ?? 0} host · ${t?.dhcpLeaseCount ?? 0} DHCP · Gagal login ${a.hotspotFailedLoginCount}x${users}`;
      }),
    ];
    return lines.join('\n');
  }

  if (!wantsFullFleet && /(vlan2000|backbone|suplai|link|ethernet|sfp|crs)/i.test(q)) {
    const list = matchedRouter ? [matchedRouter] : scope.filter((a) => (a.telemetry?.watchedLinks?.length ?? 0) > 0 || a.telemetry?.interfacePingResult);
    const effective = list.length > 0 ? list : scope;
    const lines = [`👑 LAPORAN SPV NOC — STATUS LINK BACKBONE & VLAN UTAMA:`];
    for (const a of effective) {
      const wl = a.telemetry?.watchedLinks ?? [];
      const ifp = a.telemetry?.interfacePingResult;
      lines.push(`\n${a.routerConfig.name.toUpperCase()} (${a.nama} · ${a.routerConfig.dutyLabel}):`);
      if (ifp) {
        lines.push(
          `• PING JALUR ${ifp.label}: ${ifp.avgMs !== null ? `${ifp.avgMs} ms (max ${ifp.maxMs} ms, loss ${ifp.packetLossPercent}%)` : 'RTO / PUTUS'} [${ifp.status.toUpperCase()}]`,
        );
      }
      if (wl.length > 0) {
        for (const w of wl.slice(0, 6)) {
          const stText = w.state === 'down' ? 'DOWN' : w.state === 'drop' ? `DROP -${w.dropPercent}%` : 'UP';
          lines.push(`• ${w.name}: ${stText} · Rx ${w.rxMbps} / Tx ${w.txMbps} Mbps (normal ~${w.baselineMbps} Mbps)`);
        }
      } else {
        const top = (a.telemetry?.interfaces ?? []).slice(0, 3);
        for (const i of top) {
          lines.push(`• ${i.name}: ${i.running ? 'UP' : 'DOWN'} · Rx ${i.rxMbps} / Tx ${i.txMbps} Mbps`);
        }
      }
    }
    return lines.join('\n');
  }

  if (!wantsFullFleet && /(ping|latensi|latency|rto|loss|lag|lambat|lemot)/i.test(q)) {
    const lines = [`👑 LAPORAN SPV NOC — PING JARINGAN, VLAN & INTERNET:`];
    for (const a of scope) {
      const p = a.telemetry?.ping;
      lines.push(
        `• ${a.routerConfig.name} (${a.routerConfig.host}): ${
          p ? (p.avgMs !== null ? `${p.avgMs} ms (max ${p.maxMs} ms, loss ${p.packetLossPercent}%) [${p.status.toUpperCase()}]` : 'RTO / DOWN') : 'menunggu ping…'
        }`,
      );
      const ifp = a.telemetry?.interfacePingResult;
      if (ifp) {
        lines.push(
          `  ↳ VIA ${ifp.label}: ${ifp.avgMs !== null ? `${ifp.avgMs} ms (max ${ifp.maxMs} ms, loss ${ifp.packetLossPercent}%) [${ifp.status.toUpperCase()}]` : 'RTO / PUTUS'}`,
        );
      }
    }
    for (const ep of externalPings) {
      lines.push(
        `• Internet ${ep.label} (${ep.target}): ${
          ep.avgMs !== null ? `${ep.avgMs} ms (loss ${ep.packetLossPercent}%) [${ep.status.toUpperCase()}]` : 'RTO / DOWN'
        }`,
      );
    }
    return lines.join('\n');
  }

  if (!wantsFullFleet && /(radius|timeout|anomali|gangguan|insiden|\blog\b)/i.test(q)) {
    const withAlert = agents.filter((a) => a.radiusTimeoutCount > 0 || a.mendesak.length > 0);
    if (withAlert.length === 0 && reports.length === 0) {
      return `👑 Laporan SPV NOC: Seluruh ${agents.length} router terpantau AMAN (0 RADIUS timeout, 0 anomali aktif).`;
    }
    const lines = [`👑 Laporan SPV NOC — Anomali & Eskalasi Agen NOC:`];
    for (const a of withAlert) {
      lines.push(`• ${a.routerConfig.name} (${a.nama}): ${a.mendesak.join(' | ') || `RADIUS ${a.radiusTimeoutCount}x`}`);
    }
    for (const rep of reports.slice(0, 5)) {
      lines.push(`• [${rep.category.toUpperCase()}] ${rep.routerName}: ${rep.message}${rep.sentToWa ? ' (✅ WA)' : ''}`);
    }
    return lines.join('\n');
  }

  if (/(trafik|traffic|bandwidth|mbps|olt|uplink)/i.test(q)) {
    const list = matchedRouter ? [matchedRouter] : scope;
    const lines = [`👑 Laporan SPV NOC — Trafik Utama:`];
    for (const a of list) {
      const top = (a.telemetry?.interfaces ?? []).slice(0, 3);
      lines.push(
        `• ${a.routerConfig.name}: ${
          top.map((i) => `${i.name} (Rx ${i.rxMbps}/Tx ${i.txMbps} Mbps)`).join(' | ') || 'belum ada data'
        }`,
      );
    }
    return lines.join('\n');
  }

  // Default: Complete SPV NOC Fleet Summary
  const online = agents.filter((a) => a.telemetry?.reachable).length;
  const lines = [
    `👑 Rekap Fleet SPV NOC (${online}/${agents.length} online · ${liveAgents.length} LIVE):`,
    ...scope.map((a) => {
      const t = a.telemetry;
      const pStr = t?.ping?.avgMs !== null && t?.ping ? ` · Ping ${t.ping.avgMs}ms` : '';
      return `• ${a.routerConfig.name} [${a.routerConfig.simulated ? 'SIM' : 'LIVE'}]: CPU ${t?.cpuLoadPercent ?? 0}% · PPPoE ${t?.activePppoeCount ?? 0} · HS ${t?.activeHotspotCount ?? 0} · DHCP ${t?.dhcpLeaseCount ?? 0}${pStr}`;
    }),
    ...externalPings.map(
      (ep) => `• Internet ${ep.target}: ${ep.avgMs !== null ? `${ep.avgMs} ms` : 'RTO'} (${ep.status.toUpperCase()})`,
    ),
  ];
  return lines.join('\n');
}

export function buildSpvWhatsappSummary(
  agents: readonly OfficeAgentView[],
  externalPings: readonly PingMetric[],
  reports: readonly SpvReportEntry[],
  isDailyReport = false,
): string {
  const liveAgents = agents.filter((a) => !a.routerConfig.simulated);
  const scope = liveAgents.length > 0 ? liveAgents : agents.slice(0, 4);
  const onlineLive = scope.filter((a) => a.telemetry?.reachable).length;
  const totalPppoe = scope.reduce((acc, a) => acc + (a.telemetry?.activePppoeCount ?? 0), 0);
  const totalHotspot = scope.reduce((acc, a) => acc + (a.telemetry?.activeHotspotCount ?? 0), 0);
  const totalRadius = scope.reduce((acc, a) => acc + a.radiusTimeoutCount, 0);
  const totalHsFail = scope.reduce((acc, a) => acc + a.hotspotFailedLoginCount, 0);
  const criticalReports = reports.filter((r) => r.severity === 'critical').slice(0, 3);

  const header = isDailyReport
    ? `👑 LAPORAN HARIAN SPV NOC — CAFE DATACENTER`
    : `👑 LAPORAN RINGKAS SPV NOC — CAFE DATACENTER`;

  const lines = [
    header,
    `STATUS ROUTER LIVE: ${onlineLive}/${scope.length} ONLINE · TOTAL PELANGGAN: ${totalPppoe} PPPOE, ${totalHotspot} HOTSPOT`,
    ``,
    `PERANGKAT LIVE:`,
    ...scope.map((a) => {
      const t = a.telemetry;
      const ping = t?.ping
        ? t.ping.avgMs !== null
          ? `${t.ping.avgMs} ms (loss ${t.ping.packetLossPercent}%)`
          : 'RTO'
        : '-';
      const ifPingPart = t?.interfacePingResult
        ? ` | ${t.interfacePingResult.label}: ${t.interfacePingResult.avgMs !== null ? `${t.interfacePingResult.avgMs}ms` : 'RTO'}`
        : '';
      return `• ${a.routerConfig.name}: CPU ${t?.cpuLoadPercent ?? 0}% | PPPOE ${t?.activePppoeCount ?? 0} | HS ${t?.activeHotspotCount ?? 0} | PING ${ping}${ifPingPart}`;
    }),
    ``,
    `PING INTERNET:`,
    ...externalPings.map(
      (ep) =>
        `• ${ep.label} (${ep.target}): ${ep.avgMs !== null ? `${ep.avgMs} ms (max ${ep.maxMs} ms)` : 'RTO'} · LOSS ${ep.packetLossPercent}% [${ep.status.toUpperCase()}]`,
    ),
    ``,
    `CATATAN RELEVAN:`,
    totalRadius === 0 && totalHsFail === 0 && criticalReports.length === 0
      ? `• Semua jaringan stabil, 0 RADIUS timeout, 0 anomali kritis.`
      : [
          totalRadius > 0 ? `• RADIUS Timeout terdeteksi: ${totalRadius}x` : '',
          totalHsFail > 0 ? `• Gagal login Hotspot di log: ${totalHsFail}x` : '',
          ...criticalReports.map((r) => `• [${r.category.toUpperCase()}] ${r.routerName}: ${r.message}`),
        ]
          .filter(Boolean)
          .join('\n'),
    ``,
    `Waktu: ${new Date().toLocaleString('id-ID')}`,
  ];
  return sanitizePlainAiText(lines.join('\n'));
}
