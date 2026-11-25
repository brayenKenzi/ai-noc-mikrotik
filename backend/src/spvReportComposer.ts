import { sanitizePlainAiText } from './antigravityBridge.js';
import type {
  LiveTopologyLink,
  OfficeAgentView,
  PingMetric,
  SpvReportEntry,
} from './types.js';

export interface VerifiedIncidentItem {
  readonly key: string;
  readonly category: 'offline' | 'link' | 'pppoe_mass' | 'sfp' | 'ping' | 'radius' | 'resource';
  readonly routerId: string;
  readonly routerName: string;
  readonly agentName: string;
  readonly headline: string;
  readonly verificationNote: string;
  readonly detectedAt: string;
}

export interface FleetPatternSnapshot {
  readonly currentHour: number;
  readonly periodLabel: string;
  readonly routerPatterns: readonly {
    readonly routerName: string;
    readonly agentName: string;
    readonly currentPeakIfMbps: number;
    readonly expectedHourMbps: number | null;
    readonly historicalPeakMbps: number | null;
    readonly historicalPeakHour: number | null;
    readonly patternVerdict: string;
  }[];
}

function getGeminiModelCandidates(): string[] {
  const configured = process.env.GEMINI_MODEL?.trim();
  return Array.from(new Set([configured, 'gemini-flash-lite-latest', 'gemini-2.5-flash'].filter((m): m is string => Boolean(m))));
}

async function askGeminiShortConclusion(systemInstruction: string, jsonPayload: unknown): Promise<string | null> {
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (!geminiKey) return null;

  for (const model of getGeminiModelCandidates()) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(12_000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(jsonPayload) }] }],
          generationConfig: { temperature: 0.2 },
        }),
      });
      if (!resp.ok) continue;
      const data = (await resp.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) {
        return sanitizePlainAiText(text).replace(/\n+/g, ' ').trim();
      }
    } catch {
      // Fallback to next model or deterministic conclusion
    }
  }
  return null;
}

export function buildDeterministicSummaryConclusion(
  scope: readonly OfficeAgentView[],
  patternContext?: FleetPatternSnapshot,
): string {
  const offline = scope.filter((a) => !a.telemetry?.reachable);
  const weakSfps: string[] = [];
  for (const a of scope) {
    for (const s of a.telemetry?.sfpOptics ?? []) {
      if (s.health === 'critical' || s.health === 'warning') {
        weakSfps.push(`${a.routerConfig.name} (${s.name}: ${s.rxPowerDbm ?? 'LOS'} dBm)`);
      }
    }
  }

  const parts: string[] = [];
  if (offline.length === 0) {
    parts.push(`Seluruh ${scope.length} perangkat aktif berjalan stabil.`);
  } else {
    parts.push(
      `Perhatian: ${offline.length} perangkat sedang tidak terjangkau (${offline.map((o) => `${o.routerConfig.name} dijaga ${o.nama}`).join(', ')}).`,
    );
  }

  if (patternContext) {
    parts.push(`Pola trafik saat ini berada pada fase ${patternContext.periodLabel.toLowerCase()}.`);
  }

  if (weakSfps.length > 0) {
    parts.push(
      `Pantauan preventif SFP mencatat redaman mulai tinggi pada ${weakSfps.slice(0, 3).join(', ')}; disarankan pembersihan konektor FO terjadwal.`,
    );
  } else {
    parts.push(`Seluruh sensor redaman SFP backbone berada dalam batas aman.`);
  }

  return parts.join(' ');
}

export async function composeSpvExecutiveReport(params: {
  readonly agents: readonly OfficeAgentView[];
  readonly externalPings: readonly PingMetric[];
  readonly reports: readonly SpvReportEntry[];
  readonly isDailyReport?: boolean;
  readonly patternContext?: FleetPatternSnapshot;
  readonly useAiConclusion?: boolean;
}): Promise<string> {
  const liveAgents = params.agents.filter((a) => !a.routerConfig.simulated);
  const scope = liveAgents.length > 0 ? liveAgents : params.agents.slice(0, 6);
  const onlineLive = scope.filter((a) => a.telemetry?.reachable).length;
  const totalPppoe = scope.reduce((acc, a) => acc + (a.telemetry?.activePppoeCount ?? 0), 0);
  const totalHotspot = scope.reduce((acc, a) => acc + (a.telemetry?.activeHotspotCount ?? 0), 0);

  // Peak throughput on Core/BRAS as clean headline bandwidth indicator
  const coreAndBras = scope.filter(
    (a) => a.routerConfig.dutyRole === 'bras_gateway' || a.routerConfig.dutyRole === 'core_vlan_watchdog',
  );
  const backboneCrs = scope.filter(
    (a) => a.routerConfig.dutyRole === 'backbone_master' || a.routerConfig.dutyRole === 'link_guard',
  );
  const branches = scope.filter(
    (a) =>
      a.routerConfig.dutyRole !== 'bras_gateway' &&
      a.routerConfig.dutyRole !== 'core_vlan_watchdog' &&
      a.routerConfig.dutyRole !== 'backbone_master' &&
      a.routerConfig.dutyRole !== 'link_guard',
  );

  const mainBandwidthMbps = Math.round(
    coreAndBras.reduce((max, a) => {
      const rMax = (a.telemetry?.interfaces ?? []).reduce((m, i) => Math.max(m, i.rxMbps + i.txMbps), 0);
      return Math.max(max, rMax);
    }, 0),
  );

  const extPingLine =
    params.externalPings
      .map((ep) => `${ep.target} (${ep.avgMs !== null ? `${ep.avgMs} ms` : 'RTO'})`)
      .join(' · ') || '-';

  let conclusion = buildDeterministicSummaryConclusion(scope, params.patternContext);
  if (params.useAiConclusion !== false) {
    const aiText = await askGeminiShortConclusion(
      [
        'Kamu adalah SPV NOC (Supervisor AI jaringan ISP MikroTik).',
        'Buat tepat 2 sampai 3 kalimat kesimpulan eksekutif Bahasa Indonesia yang rapi, tenang, mudah dipahami pemilik jaringan.',
        'Gunakan NAMA ROUTER dan NAMA AGEN terbaru persis sesuai JSON.',
        'Bahas: (1) kondisi koneksi & kesesuaian pemakaian bandwidth terhadap pola jam ini, dan (2) catatan redaman SFP atau perangkat yang perlu perhatian.',
        'DILARANG menggunakan tanda bintang (*), pagar (#), atau bullet. Cukup paragraf singkat bersih.',
      ].join(' '),
      {
        onlineRouters: `${onlineLive}/${scope.length}`,
        totalPppoe,
        totalHotspot,
        mainBandwidthMbps,
        patternContext: params.patternContext ?? null,
        sfpHighlights: backboneCrs.map((c) => ({
          router: c.routerConfig.name,
          agent: c.nama,
          sfps: (c.telemetry?.sfpOptics ?? [])
            .filter((s) => s.health !== 'empty')
            .map((s) => ({ port: s.name, rxDbm: s.rxPowerDbm, health: s.health })),
        })),
      },
    );
    if (aiText) conclusion = aiText;
  }

  const title = params.isDailyReport ? 'LAPORAN HARIAN SPV NOC' : 'LAPORAN RINGKAS SPV NOC';
  const lines: string[] = [
    title,
    `${new Date().toLocaleString('id-ID')}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `RINGKASAN JARINGAN`,
    `• Perangkat Aktif : ${onlineLive}/${scope.length} Router Online`,
    `• Pelanggan Aktif : ${totalPppoe} PPPoE · ${totalHotspot} Hotspot`,
    `• Trafik Utama    : ~${mainBandwidthMbps} Mbps`,
    `• Ping Internet   : ${extPingLine}`,
  ];

  if (params.patternContext) {
    lines.push(`• Pola Waktu      : ${params.patternContext.periodLabel}`);
  }

  if (coreAndBras.length > 0) {
    lines.push(``, `CORE & PUSAT LAYANAN`);
    for (const a of coreAndBras) {
      const t = a.telemetry;
      const topIf = (t?.interfaces ?? [])[0];
      const bwPart = topIf ? ` · ${topIf.name}: ${Math.round(topIf.rxMbps + topIf.txMbps)} Mbps` : '';
      const vlanPing = t?.interfacePingResult
        ? ` · Ping VLAN ${t.interfacePingResult.avgMs !== null ? `${t.interfacePingResult.avgMs} ms` : 'RTO'}`
        : '';
      lines.push(
        `• ${a.routerConfig.name} (${a.nama})`,
        `  ${t?.reachable ? `CPU ${t.cpuLoadPercent}% · ${t.activePppoeCount} PPPoE · ${t.activeHotspotCount} HS${bwPart}${vlanPing}` : 'STATUS: OFFLINE'}`,
      );
    }
  }

  if (backboneCrs.length > 0) {
    lines.push(``, `CRS BACKBONE & REDAMAN SFP`);
    for (const a of backboneCrs) {
      const t = a.telemetry;
      const activeSfps = (t?.sfpOptics ?? []).filter((s) => s.health !== 'empty');
      const warnOrCrit = activeSfps.filter((s) => s.health === 'warning' || s.health === 'critical');
      let sfpSummary = 'Belum ada modul SFP aktif';
      if (activeSfps.length > 0) {
        if (warnOrCrit.length > 0) {
          sfpSummary = `${activeSfps.length} SFP aktif (${warnOrCrit.map((w) => `${w.name}: ${w.rxPowerDbm ?? 'LOS'} dBm`).join(', ')})`;
        } else {
          const best = activeSfps.map((s) => `${s.name} ${s.rxPowerDbm} dBm`).slice(0, 2).join(', ');
          sfpSummary = `${activeSfps.length} SFP normal (${best})`;
        }
      }
      lines.push(
        `• ${a.routerConfig.name} (${a.nama})`,
        `  ${t?.reachable ? `CPU ${t.cpuLoadPercent}% · ${sfpSummary}` : 'STATUS: OFFLINE'}`,
      );
    }
  }

  if (branches.length > 0) {
    lines.push(``, `DISTRIBUSI CABANG`);
    for (const a of branches) {
      const t = a.telemetry;
      const pMs = t?.ping?.avgMs !== null && t?.ping ? `${t.ping.avgMs} ms` : 'RTO';
      lines.push(
        `• ${a.routerConfig.name} (${a.nama})`,
        `  ${t?.reachable ? `${t.activePppoeCount} PPPoE · ${t.activeHotspotCount} HS · CPU ${t.cpuLoadPercent}% · Ping ${pMs}` : 'STATUS: OFFLINE'}`,
      );
    }
  }

  lines.push(``, `KESIMPULAN ANALISA SPV AI`, conclusion);
  return sanitizePlainAiText(lines.join('\n'));
}

export async function composeSpvVerifiedIncidentReport(params: {
  readonly incidents: readonly VerifiedIncidentItem[];
  readonly agents: readonly OfficeAgentView[];
  readonly topologyLinks: readonly LiveTopologyLink[];
  readonly patternContext?: FleetPatternSnapshot;
}): Promise<string> {
  const { incidents, topologyLinks, patternContext } = params;

  // Deterministic root-cause correlation fallback
  const involvedNames = Array.from(new Set(incidents.map((i) => `${i.routerName} (${i.agentName})`)));
  const relatedCables = topologyLinks.filter((l) =>
    incidents.some((inc) => inc.routerId === l.fromRouterId || inc.routerId === l.toRouterId),
  );

  let conclusion =
    incidents.length > 1
      ? `Terdeteksi ${incidents.length} kejadian bersamaan pada ${involvedNames.join(', ')}. Kemungkinan kuat bersumber dari satu jalur distribusi/uplink yang sama${relatedCables[0] ? ` (${relatedCables[0].fromRouterName} -> ${relatedCables[0].toRouterName})` : ''}; silakan periksa titik hulu terlebih dahulu.`
      : `Gangguan pada ${involvedNames[0] ?? 'perangkat'} sudah melewati pengecekan ulang otomatis dan bukan sekadar penurunan trafik jam sepi. Disarankan pemeriksaan jalur fisik/perangkat terkait.`;

  const aiText = await askGeminiShortConclusion(
    [
      'Kamu adalah SPV NOC (Supervisor AI jaringan ISP MikroTik).',
      'Simpulkan akar masalah (root cause) dari daftar insiden yang SUDAH TERVERIFIKASI tes ulang ini dalam 2 sampai 3 kalimat Bahasa Indonesia yang tegas, rapi, dan mudah dipahami.',
      'Gunakan NAMA ROUTER dan NAMA AGEN terbaru persis sesuai data.',
      'Hubungkan dengan fiberTopology jika ada beberapa router hilir terdampak bersamaan, dan beri saran tindakan paling tepat.',
      'DILARANG memakai tanda bintang (*), pagar (#), atau bullet.',
    ].join(' '),
    {
      verifiedIncidents: incidents,
      fiberTopology: relatedCables.map((l) => ({
        from: `${l.fromRouterName} (${l.fromInterface})`,
        to: `${l.toRouterName} (${l.toInterface})`,
        status: l.status,
      })),
      bandwidthPattern: patternContext?.periodLabel ?? null,
    },
  );
  if (aiText) conclusion = aiText;

  const lines: string[] = [
    `LAPORAN INSIDEN TERVERIFIKASI — SPV NOC`,
    `${new Date().toLocaleString('id-ID')}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `TEMUAN AGEN (${incidents.length} TERKONFIRMASI TES ULANG)`,
  ];

  for (const inc of incidents) {
    lines.push(
      `• ${inc.routerName} — Agen: ${inc.agentName}`,
      `  Masalah : ${inc.headline}`,
      `  Tes     : ${inc.verificationNote}`,
    );
  }

  lines.push(``, `KESIMPULAN ANALISA SPV AI`, conclusion);
  return sanitizePlainAiText(lines.join('\n'));
}

export function composeSpvRecoveryReport(
  items: readonly { readonly routerName: string; readonly agentName: string; readonly detail: string }[],
): string {
  const lines: string[] = [
    `LAPORAN PEMULIHAN JARINGAN — SPV NOC`,
    `${new Date().toLocaleString('id-ID')}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `STATUS KEMBALI NORMAL`,
    ...items.map((it) => `• ${it.routerName} (${it.agentName}): ${it.detail}`),
  ];
  return sanitizePlainAiText(lines.join('\n'));
}
