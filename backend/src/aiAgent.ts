import { getGeminiModelCandidates } from './antigravityBridge.js';
import { validateAndBuildPlaybook } from './playbooks.js';
import { parseRadiusTimeoutUser } from './syslogReceiver.js';
import type {
  ActionProposalPayload,
  PlaybookActionType,
  RouterDevice,
  RouterTelemetry,
  SyslogEntry,
} from './types.js';

export interface AgentDiagnosisResult {
  readonly incidentSummary: string;
  readonly rootCauseAnalysis: string;
  readonly requiresAction: boolean;
  readonly proposal: ActionProposalPayload | null;
}

interface CloudLlmRawJson {
  incidentSummary?: string;
  rootCauseAnalysis?: string;
  requiresAction?: boolean;
  actionType?: PlaybookActionType;
  parameters?: Record<string, string>;
}

/**
 * Analyzes MikroTik telemetry & syslog anomalies using Cloud LLM API
 * (Supports Gemini API or OpenAI/DeepSeek compatible Chat Completions endpoint),
 * with deterministic expert heuristic fallback when API key is not yet configured.
 */
export async function analyzeRouterIncident(
  router: RouterDevice,
  telemetry: RouterTelemetry | null,
  recentLogs: readonly SyslogEntry[],
  nocServerIp?: string,
): Promise<AgentDiagnosisResult> {
  // Preserve Cloud LLM quota for interactive SPV NOC chat unless AI_AUTO_DIAGNOSIS=true is explicitly set
  const allowAutoLlm = process.env.AI_AUTO_DIAGNOSIS === 'true';
  const geminiKey = allowAutoLlm ? process.env.GEMINI_API_KEY?.trim() : '';
  const openaiKey = allowAutoLlm ? process.env.LLM_API_KEY?.trim() : '';

  if (geminiKey) {
    try {
      return await callGeminiDiagnosis(geminiKey, router, telemetry, recentLogs, nocServerIp);
    } catch {
      // Fallback cleanly to deterministic diagnosis if network/quota fails
    }
  } else if (openaiKey) {
    try {
      return await callOpenAiCompatibleDiagnosis(openaiKey, router, telemetry, recentLogs, nocServerIp);
    } catch {
      // Fallback cleanly to deterministic diagnosis
    }
  }

  return deterministicDiagnosis(router, telemetry, recentLogs, nocServerIp);
}

function buildSystemPrompt(router: RouterDevice): string {
  return [
    `Kamu adalah ${router.agentName}, AI NOC Engineer khusus untuk MikroTik "${router.name}" (${router.host}, RouterOS ${router.routerOsVersion}, role: ${router.role}).`,
    `Tugasmu menganalisis metrik dan syslog MikroTik, menjelaskan akar masalah secara ringkas dalam Bahasa Indonesia, dan mengusulkan tindakan dari playbook resmi.`,
    `Playbook yang diizinkan (actionType):`,
    `- ADD_FIREWALL_BLOCKLIST: parameter wajib { "ip": "x.x.x.x", "list": "AI_NOC_BLOCKLIST", "timeout": "24h" }`,
    `- RESET_PPPOE_SESSION: parameter wajib { "username": "nama_user_pppoe" }`,
    `- ENABLE_INTERFACE: parameter wajib { "interface": "nama_interface" }`,
    `- SWITCH_BACKUP_ROUTE: parameter wajib { "routeComment": "ISP_BACKUP", "distance": "1" }`,
    `- DIAGNOSTIC_ONLY: parameter {}`,
    `Balas HANYA dalam format JSON murni: {"incidentSummary":"...","rootCauseAnalysis":"...","requiresAction":true/false,"actionType":"...","parameters":{...}}`,
  ].join('\n');
}

async function callGeminiDiagnosis(
  apiKey: string,
  router: RouterDevice,
  telemetry: RouterTelemetry | null,
  recentLogs: readonly SyslogEntry[],
  nocServerIp?: string,
): Promise<AgentDiagnosisResult> {
  const userContext = JSON.stringify({
    router: { name: router.name, role: router.role, version: router.routerOsVersion },
    telemetry,
    recentLogs: recentLogs.slice(0, 12),
  });

  let lastError: Error | null = null;
  for (const model of getGeminiModelCandidates()) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemPrompt(router) }] },
          contents: [{ role: 'user', parts: [{ text: userContext }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
      });

      if (!resp.ok) {
        lastError = new Error(`Gemini API HTTP ${resp.status} (${model})`);
        continue;
      }
      const data = (await resp.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
      return normalizeLlmOutput(JSON.parse(rawText) as CloudLlmRawJson, router, telemetry, recentLogs, nocServerIp);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('Gemini API error');
    }
  }
  throw lastError ?? new Error('Semua model Gemini gagal merespons');
}

async function callOpenAiCompatibleDiagnosis(
  apiKey: string,
  router: RouterDevice,
  telemetry: RouterTelemetry | null,
  recentLogs: readonly SyslogEntry[],
  nocServerIp?: string,
): Promise<AgentDiagnosisResult> {
  const baseUrl = (process.env.LLM_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.LLM_MODEL?.trim() || 'gpt-4o-mini';

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildSystemPrompt(router) },
        {
          role: 'user',
          content: JSON.stringify({ telemetry, recentLogs: recentLogs.slice(0, 10) }),
        },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(`LLM API HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const rawText = data.choices?.[0]?.message?.content ?? '{}';
  return normalizeLlmOutput(JSON.parse(rawText) as CloudLlmRawJson, router, telemetry, recentLogs, nocServerIp);
}

function normalizeLlmOutput(
  parsed: CloudLlmRawJson,
  router: RouterDevice,
  telemetry: RouterTelemetry | null,
  recentLogs: readonly SyslogEntry[],
  nocServerIp?: string,
): AgentDiagnosisResult {
  const actionType = parsed.actionType ?? 'DIAGNOSTIC_ONLY';
  const params = parsed.parameters ?? {};

  if (!parsed.requiresAction || actionType === 'DIAGNOSTIC_ONLY') {
    return {
      incidentSummary: parsed.incidentSummary ?? `Pemantauan anomali pada ${router.name}`,
      rootCauseAnalysis: parsed.rootCauseAnalysis ?? 'Perlu pemantauan lanjutan tanpa perubahan konfigurasi.',
      requiresAction: false,
      proposal: null,
    };
  }

  try {
    const built = validateAndBuildPlaybook(actionType, params, nocServerIp);
    return {
      incidentSummary: parsed.incidentSummary ?? `Anomali terdeteksi pada ${router.name}`,
      rootCauseAnalysis: parsed.rootCauseAnalysis ?? 'Analisis otomatis selesai.',
      requiresAction: true,
      proposal: {
        actionType,
        parameters: params,
        previewCommand: built.previewCommand,
        rollbackCommand: built.rollbackCommand,
        riskLevel: built.riskLevel,
      },
    };
  } catch {
    return deterministicDiagnosis(router, telemetry, recentLogs, nocServerIp);
  }
}

function isPrivateLanIp(ip: string): boolean {
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('127.')) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m?.[1]) {
    const oct = Number(m[1]);
    if (oct >= 16 && oct <= 31) return true;
  }
  return false;
}

export function deterministicDiagnosis(
  router: RouterDevice,
  telemetry: RouterTelemetry | null,
  recentLogs: readonly SyslogEntry[],
  nocServerIp?: string,
): AgentDiagnosisResult {
  // 0. PRIORITY #1: RADIUS Timeout / Disconnect detection
  // Example: <0fea>: user "NAMA USER" authentication failed - radius timeout
  for (const log of recentLogs) {
    const failedUser = parseRadiusTimeoutUser(log.message);
    if (failedUser) {
      const built = validateAndBuildPlaybook('DIAGNOSTIC_ONLY', {}, nocServerIp);
      return {
        incidentSummary: `🚨 RADIUS TIMEOUT pada ${router.name}: user "${failedUser}" gagal autentikasi`,
        rootCauseAnalysis: `MikroTik ${router.name} tidak mendapat balasan dari server RADIUS untuk user "${failedUser}". Periksa koneksi/routing ke IP RADIUS, status service FreeRADIUS/Userman, kesesuaian RADIUS secret, serta firewall UDP 1812/1813.`,
        requiresAction: true,
        proposal: {
          actionType: 'DIAGNOSTIC_ONLY',
          parameters: { user: failedUser },
          previewCommand: `/radius monitor numbers=0 once # Cek status koneksi RADIUS untuk user "${failedUser}"`,
          rollbackCommand: built.rollbackCommand,
          riskLevel: 'HIGH',
        },
      };
    }
  }

  // Track interfaces that already have a NEWER "link up" log (recentLogs is newest-first)
  const recoveredInLogs = new Set<string>();

  // 1. Check logs (newest-first)
  for (const log of recentLogs) {
    const linkUpMatch = /([a-zA-Z0-9._-]+)\s+link up/i.exec(log.message);
    if (linkUpMatch?.[1]) {
      recoveredInLogs.add(linkUpMatch[1].toLowerCase());
    }

    // Check brute-force login failure from external public IP (skip private LAN admin typos)
    const bruteMatch = /login failure for user\s+\S+\s+from\s+(\d{1,3}(?:\.\d{1,3}){3})/i.exec(log.message);
    if (bruteMatch?.[1] && !isPrivateLanIp(bruteMatch[1])) {
      const attackerIp = bruteMatch[1];
      try {
        const params = { ip: attackerIp, list: 'AI_NOC_BLOCKLIST', timeout: '24h' };
        const built = validateAndBuildPlaybook('ADD_FIREWALL_BLOCKLIST', params, nocServerIp);
        return {
          incidentSummary: `Percobaan brute-force dari IP ${attackerIp} pada ${router.name}`,
          rootCauseAnalysis: `Terdeteksi kegagalan autentikasi berulang dari IP eksternal ${attackerIp} di log ${router.name}. Disarankan memasukkan IP ke address-list blokir selama 24 jam.`,
          requiresAction: true,
          proposal: {
            actionType: 'ADD_FIREWALL_BLOCKLIST',
            parameters: params,
            previewCommand: built.previewCommand,
            rollbackCommand: built.rollbackCommand,
            riskLevel: built.riskLevel,
          },
        };
      } catch {
        // Protected IP, skip blocking
      }
    }

    // 2. Check WAN / interface link down — MUST cross-check live telemetry & newer link-up logs!
    const linkDownMatch = /([a-zA-Z0-9._-]+)\s+link down/i.exec(log.message);
    if (linkDownMatch?.[1]) {
      const downIface = linkDownMatch[1];
      const downLower = downIface.toLowerCase();

      // If a newer log already confirmed link up -> historical flap, skip!
      if (recoveredInLogs.has(downLower)) {
        continue;
      }

      // Cross-check live RouterOS interface state from telemetry!
      const liveIf = telemetry?.interfaces.find((i) => i.name.toLowerCase() === downLower);
      if (liveIf && liveIf.running && !liveIf.disabled) {
        // Port is currently UP & active! Old historical log -> NEVER create a false link-down ticket!
        continue;
      }

      if (downLower.includes('isp') || downLower.includes('wan')) {
        const params = { routeComment: 'ISP_BACKUP', distance: '1' };
        const built = validateAndBuildPlaybook('SWITCH_BACKUP_ROUTE', params, nocServerIp);
        return {
          incidentSummary: `Link utama ${downIface} DOWN di ${router.name}`,
          rootCauseAnalysis: `Interface uplink ${downIface} mengalami putus koneksi fisik/optik. Agen menyarankan menurunkan distance jalur ISP_BACKUP menjadi 1 agar trafik pelanggan dialihkan penuh.`,
          requiresAction: true,
          proposal: {
            actionType: 'SWITCH_BACKUP_ROUTE',
            parameters: params,
            previewCommand: built.previewCommand,
            rollbackCommand: built.rollbackCommand,
            riskLevel: built.riskLevel,
          },
        };
      }

      // ONLY propose `/interface enable` if live telemetry proves the port is actually DISABLED (`disabled === true`)!
      // If `disabled === false`, the port is NOT disabled (physical FO/SFP issue handled by LinkWatchdog, not `/interface enable`!).
      if (liveIf && liveIf.disabled) {
        const params = { interface: downIface };
        const built = validateAndBuildPlaybook('ENABLE_INTERFACE', params, nocServerIp);
        return {
          incidentSummary: `Interface ${downIface} dalam status DISABLED pada ${router.name}`,
          rootCauseAnalysis: `Telemetri live memastikan port ${downIface} sedang nonaktif (disabled=true). Aktifkan kembali bila penonaktifan tidak disengaja.`,
          requiresAction: true,
          proposal: {
            actionType: 'ENABLE_INTERFACE',
            parameters: params,
            previewCommand: built.previewCommand,
            rollbackCommand: built.rollbackCommand,
            riskLevel: built.riskLevel,
          },
        };
      }

      // Port is enabled (not disabled) or live telemetry unavailable -> never spam false `/interface enable`!
      continue;
    }

    // 3. Check stuck PPPoE session
    const pppStuckMatch = /pppoe.*?<([a-zA-Z0-9._-]+)>.*?(disconnected|peer is not responding|hung)/i.exec(
      log.message,
    );
    if (pppStuckMatch?.[1]) {
      const pppUser = pppStuckMatch[1];
      const params = { username: pppUser };
      const built = validateAndBuildPlaybook('RESET_PPPOE_SESSION', params, nocServerIp);
      return {
        incidentSummary: `Sesi PPPoE pelanggan ${pppUser} menggantung di ${router.name}`,
        rootCauseAnalysis: `Sesi PPPoE ${pppUser} tidak merespons keepalive. Mereset sesi aktif akan memicu perangkat ONT pelanggan melakukan redial bersih.`,
        requiresAction: true,
        proposal: {
          actionType: 'RESET_PPPOE_SESSION',
          parameters: params,
          previewCommand: built.previewCommand,
          rollbackCommand: built.rollbackCommand,
          riskLevel: built.riskLevel,
        },
      };
    }
  }

  if (telemetry && telemetry.cpuLoadPercent >= 85) {
    return {
      incidentSummary: `Lonjakan CPU ${telemetry.cpuLoadPercent}% pada ${router.name}`,
      rootCauseAnalysis: `Beban CPU melampaui ambang aman (${telemetry.cpuLoadPercent}%). Disarankan memeriksa /tool profile pada jam sibuk sebelum melakukan limitasi queue.`,
      requiresAction: false,
      proposal: null,
    };
  }

  return {
    incidentSummary: `${router.name} beroperasi normal`,
    rootCauseAnalysis: 'Tidak ditemukan anomali kritis pada log maupun telemetri.',
    requiresAction: false,
    proposal: null,
  };
}
