import crypto from 'node:crypto';
import type {
  AlertSettings,
  ApprovalTicket,
  NewRouterInput,
  NocSnapshot,
  OfficeAgentView,
  PingMetric,
  RadiusTimeoutAlert,
  RouterDevice,
  RouterPublicConfig,
  RouterTelemetry,
  RouterUpdatePatch,
  SpvNocState,
  SpvReportEntry,
  SyslogEntry,
  TelemetryPoint,
} from './types.js';
import { allocateDeskSlot } from './inventory.js';
import {
  pollRouterInterfacePing,
  pollRouterTelemetry,
  pollRouterWithLogs,
  sharedRouterOsPool,
} from './poller.js';
import { LinkWatchdogEngine, resolveRouterDutyProfile } from './linkWatchdog.js';
import { PppoeMassDisconnectWatchdog } from './pppoeWatchdog.js';
import { SfpOpticalWatchdog } from './sfpMonitor.js';
import {
  extractCustomerLookupQuery,
  formatCustomerLookupPlainText,
  searchCustomersAcrossFleet,
} from './customerLookup.js';
import type { RscBackupManager } from './rscBackupManager.js';
import type { TrafficPatternLearner } from './trafficPatternLearner.js';
import { detectNmsChatIntent, type NmsToolSuite } from './nmsTools.js';
import {
  composeSpvExecutiveReport,
  composeSpvRecoveryReport,
  composeSpvVerifiedIncidentReport,
  type VerifiedIncidentItem,
} from './spvReportComposer.js';
import type { NewTopologyLinkInput, TopologyStore } from './topologyStore.js';
import type { AiMemoryStore } from './aiMemoryStore.js';
import type {
  AiLearnedFact,
  CustomerLookupResult,
  RscBackupSummary,
  SfpOpticalMetric,
  TopologyLink,
  TopologyNodePosition,
} from './types.js';
import {
  isAnomalySyslog,
  isRadiusTimeoutMessage,
  parseHotspotFailedLogin,
  parseRadiusTimeoutUser,
} from './syslogReceiver.js';
import { analyzeRouterIncident } from './aiAgent.js';
import { ApprovalGateStore } from './approvalStore.js';
import { executeApprovedProposal, hasWriteCredentialsForRouter } from './playbooks.js';
import { TelegramNocBot } from './telegramBot.js';
import type { SecretVault } from './secretVault.js';
import {
  AntigravityBridgeStore,
  buildSpvWhatsappSummary,
  generateLiveAgentAnswer,
  generateSpvFleetAnswer,
} from './antigravityBridge.js';
import { runSinglePing, type PingThresholds } from './pingMonitor.js';
import type { FonnteWhatsappNotifier } from './fonnteNotifier.js';

const MAX_HISTORY_POINTS = 30;
const MAX_GLOBAL_LOGS = 100;

export function toPublicRouterConfig(router: RouterDevice): RouterPublicConfig {
  const profile = resolveRouterDutyProfile(router);
  return {
    id: router.id,
    name: router.name,
    agentName: router.agentName,
    dutyRole: profile.dutyRole,
    dutyLabel: profile.dutyLabel,
    watchedInterfaces: profile.watchedInterfaces,
    trafficDropThresholdPct: profile.trafficDropThresholdPct,
    minTrafficMbps: profile.minTrafficMbps,
    interfacePing: profile.interfacePing,
    customPrompt: profile.customPrompt,
    deviceModel: router.deviceModel ?? (router.routerOsVersion === 'v7' ? 'MikroTik ROS v7' : 'MikroTik ROS v6'),
    host: router.host,
    port: router.port,
    useTls: router.useTls,
    routerOsVersion: router.routerOsVersion,
    role: router.role,
    readUsername: router.readUsername,
    hasCustomReadPassword: Boolean(router.readPasswordEnc),
    writeExecutionReady: hasWriteCredentialsForRouter(router),
    simulated: router.simulated ?? false,
  };
}

function slugifyRouterId(name: string, existingIds: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'mikrotik';
  if (!existingIds.has(base)) return base;
  return `${base}-${crypto.randomUUID().slice(0, 4)}`;
}

export class NocOrchestrator {
  private routers: readonly RouterDevice[];
  private readonly telemetryMap = new Map<string, RouterTelemetry>();
  private readonly pingMap = new Map<string, PingMetric>();
  private readonly interfacePingMap = new Map<string, PingMetric>();
  private readonly linkWatchdog = new LinkWatchdogEngine();
  private readonly pppoeWatchdog = new PppoeMassDisconnectWatchdog();
  private readonly sfpWatchdog = new SfpOpticalWatchdog();
  private readonly sfpOpticsMap = new Map<string, readonly SfpOpticalMetric[]>();
  private pingSweepTick = 0;
  private externalPings: readonly PingMetric[] = [];
  private readonly historyMap = new Map<string, readonly TelemetryPoint[]>();
  private readonly logsMap = new Map<string, readonly SyslogEntry[]>();
  private readonly seenLogIds = new Set<string>();
  private globalLogs: readonly SyslogEntry[] = [];
  private spvReports: readonly SpvReportEntry[] = [];
  private readonly cooldownMap = new Map<string, number>();
  private readonly pingFailStreakMap = new Map<string, number>();
  private readonly pingOkStreakMap = new Map<string, number>();
  private readonly offlineStreakMap = new Map<string, number>();
  private readonly resourceCritStreakMap = new Map<string, number>();
  private readonly radiusBurstMap = new Map<string, number[]>();
  private readonly approvalStore: ApprovalGateStore;
  private readonly telegramBot: TelegramNocBot;
  private readonly fonnteNotifier?: FonnteWhatsappNotifier;
  private readonly topologyStore?: TopologyStore;
  private readonly aiMemoryStore?: AiMemoryStore;
  private readonly rscBackupManager?: RscBackupManager;
  private readonly trafficPatternLearner?: TrafficPatternLearner;
  private readonly nmsTools?: NmsToolSuite;
  private readonly pendingIncidentsMap = new Map<string, VerifiedIncidentItem>();
  private readonly pendingRecoveriesMap = new Map<
    string,
    { readonly key: string; readonly routerId: string; readonly routerName: string; readonly agentName: string; readonly detail: string }
  >();
  private incidentBatchTimer: NodeJS.Timeout | null = null;
  private recoveryBatchTimer: NodeJS.Timeout | null = null;
  private readonly externalPingTargets: readonly string[];
  private readonly nocServerIp: string;
  private readonly onBroadcast: (snapshot: NocSnapshot) => void;
  private readonly onPersistRouters?: (routers: readonly RouterDevice[]) => Promise<void>;
  private readonly secretVault?: SecretVault;
  private readonly aiBridge?: AntigravityBridgeStore;
  private pollTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private dailyReportTimer: NodeJS.Timeout | null = null;
  private rscInitTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private pinging = false;

  constructor(options: {
    readonly routers: readonly RouterDevice[];
    readonly approvalStore: ApprovalGateStore;
    readonly nocServerIp: string;
    readonly telegramToken: string;
    readonly telegramChatId: string;
    readonly onBroadcast: (snapshot: NocSnapshot) => void;
    readonly onPersistRouters?: (routers: readonly RouterDevice[]) => Promise<void>;
    readonly secretVault?: SecretVault;
    readonly aiBridge?: AntigravityBridgeStore;
    readonly fonnteNotifier?: FonnteWhatsappNotifier;
    readonly topologyStore?: TopologyStore;
    readonly aiMemoryStore?: AiMemoryStore;
    readonly rscBackupManager?: RscBackupManager;
    readonly trafficPatternLearner?: TrafficPatternLearner;
    readonly nmsTools?: NmsToolSuite;
    readonly externalPingTargets?: readonly string[];
  }) {
    this.routers = options.routers;
    this.approvalStore = options.approvalStore;
    this.nocServerIp = options.nocServerIp;
    this.onBroadcast = options.onBroadcast;
    this.onPersistRouters = options.onPersistRouters;
    this.secretVault = options.secretVault;
    this.aiBridge = options.aiBridge;
    this.fonnteNotifier = options.fonnteNotifier;
    this.topologyStore = options.topologyStore;
    this.aiMemoryStore = options.aiMemoryStore;
    this.rscBackupManager = options.rscBackupManager;
    this.trafficPatternLearner = options.trafficPatternLearner;
    this.nmsTools = options.nmsTools;
    this.externalPingTargets =
      options.externalPingTargets && options.externalPingTargets.length > 0
        ? options.externalPingTargets
        : ['1.1.1.1', '8.8.8.8'];

    this.telegramBot = new TelegramNocBot(options.telegramToken, options.telegramChatId, {
      onApprove: (ticketId, actor) => this.approveAndExecute(ticketId, actor),
      onReject: (ticketId, actor) => this.rejectProposal(ticketId, actor),
      onSpvChat: (question, actor) => this.askSpvNoc(question, undefined, actor),
    });
  }

  getRouters(): readonly RouterDevice[] {
    return this.routers;
  }

  getPublicRouters(): readonly RouterPublicConfig[] {
    return this.routers.map(toPublicRouterConfig);
  }

  getApprovals(): readonly ApprovalTicket[] {
    return this.approvalStore.getAll();
  }

  getGlobalLogs(): readonly SyslogEntry[] {
    return this.globalLogs;
  }

  async askAgentAi(routerId: string, question: string): Promise<{ readonly reply: string; readonly source: string }> {
    const router = this.routers.find((r) => r.id === routerId);
    if (!router) {
      throw new Error(`Router ${routerId} tidak ditemukan`);
    }
    const baseTel = this.telemetryMap.get(routerId) ?? null;
    const ping = this.pingMap.get(routerId) ?? null;
    const telemetry = baseTel ? { ...baseTel, ping } : null;
    const history = this.historyMap.get(routerId) ?? [];
    const recentLogs = this.logsMap.get(routerId) ?? [];

    const result = await generateLiveAgentAnswer({
      router,
      telemetry,
      history,
      recentLogs,
      externalPings: this.externalPings,
      question,
    });
    if (this.aiBridge) {
      await this.aiBridge.appendConversation(routerId, question, result.reply, result.source);
    }
    this.broadcast();
    return result;
  }

  async lookupCustomer(query: string): Promise<CustomerLookupResult> {
    const reachableIds = new Set<string>();
    for (const [id, tel] of this.telemetryMap.entries()) {
      if (tel.reachable) reachableIds.add(id);
    }
    return searchCustomersAcrossFleet({
      query,
      routers: this.routers,
      resolveSecret: (r) => this.resolveReadSecret(r) ?? '',
      pool: sharedRouterOsPool,
      logsByRouter: this.logsMap,
      ...(reachableIds.size > 0 ? { reachableRouterIds: reachableIds } : {}),
    });
  }

  async runRscBackupNow(): Promise<RscBackupSummary> {
    if (!this.rscBackupManager) {
      throw new Error('Manajer backup .rsc belum diaktifkan');
    }
    const summary = await this.rscBackupManager.backupAllRouters({
      routers: this.routers,
      resolveSecret: (r) => this.resolveReadSecret(r) ?? '',
      pool: sharedRouterOsPool,
      syncGit: true,
    });
    this.broadcast();
    return summary;
  }

  async readRscFileContent(fileName: string): Promise<string | null> {
    if (!this.rscBackupManager) return null;
    return this.rscBackupManager.readRouterRscContent(fileName);
  }

  async askSpvNoc(
    question: string,
    focusRouterId?: string,
    userSource = 'Boss / Admin',
  ): Promise<{ readonly reply: string; readonly source: string }> {
    // 1. Instant /backup_rsc trigger from Telegram or Web chat
    if (/^\/backup_rsc\b/i.test(question.trim()) && this.rscBackupManager) {
      const summary = await this.runRscBackupNow();
      const okCount = summary.entries.filter((e) => e.status !== 'error').length;
      const lines = [
        `💾 BACKUP KONFIGURASI MIKROTIK (.RSC) SELESAI!`,
        `Folder Terpisah: ${summary.folderName}/latest/ & ${summary.folderName}/history/`,
        `Berhasil: ${okCount}/${summary.entries.length} router live`,
        `Status Git Private: ${summary.lastGitSyncStatus}`,
        '',
        ...summary.entries.map((e) =>
          e.status === 'error'
            ? `• [GAGAL] ${e.routerName}: ${e.error ?? 'Unreachable'}`
            : `• [OK] ${e.routerName} -> ${e.folderPath} (${e.lineCount} baris${e.addedLines > 0 || e.removedLines > 0 ? `, +${e.addedLines}/-${e.removedLines} berubah` : ', tidak berubah'})`,
        ),
      ];
      const result = { reply: lines.join('\n'), source: 'SPV NOC · RSC Vault' };
      if (this.aiBridge) {
        await this.aiBridge.appendConversation('spv-noc', question, result.reply, result.source, userSource);
      }
      this.broadcast();
      return result;
    }

    // 1b. ADT Monitoring NMS Tools (OLT Alarms, GenieACS Wi-Fi, Human-Confirmed Reboot & Wi-Fi Change)
    const nmsIntent = detectNmsChatIntent(question);
    if (nmsIntent && this.nmsTools?.isConfigured) {
      let reply = '';
      if (nmsIntent.tool === 'cek_gangguan_jaringan') {
        reply = (await this.nmsTools.cekGangguanJaringan()).formattedText;
      } else if (nmsIntent.tool === 'cek_perangkat_wifi') {
        reply = (await this.nmsTools.cekPerangkatWifi(nmsIntent.query)).formattedText;
      } else if (nmsIntent.tool === 'reboot_modem') {
        reply = (await this.nmsTools.requestRebootModem(nmsIntent.query, userSource)).formattedText;
      } else if (nmsIntent.tool === 'ubah_wifi_pelanggan') {
        reply = (
          await this.nmsTools.requestUbahWifi({
            query: nmsIntent.query,
            ssid: nmsIntent.ssid,
            password: nmsIntent.password,
            requestedBy: userSource,
          })
        ).formattedText;
      } else if (nmsIntent.tool === 'confirm_action') {
        reply = (await this.nmsTools.confirmPendingAction(nmsIntent.actionId, userSource)).formattedText;
      } else if (nmsIntent.tool === 'cancel_action') {
        reply = this.nmsTools.cancelPendingAction(nmsIntent.actionId).formattedText;
      }
      const result = { reply, source: 'SPV NOC · ADT Monitoring NMS' };
      if (this.aiBridge) {
        await this.aiBridge.appendConversation('spv-noc', question, result.reply, result.source, userSource);
      }
      if (this.aiMemoryStore && nmsIntent.tool !== 'ubah_wifi_pelanggan') {
        await this.aiMemoryStore.recordConversation(userSource, question, result.reply, result.source);
      }
      this.broadcast();
      return result;
    }

    // 2. Instant live customer lookup (/cek <user/ip/mac> -> combines MikroTik PPPoE/Hotspot + ADT NMS OLT/Modem!)
    const customerQuery = extractCustomerLookupQuery(question);
    if (customerQuery) {
      const [lookup, nmsLookup] = await Promise.all([
        this.lookupCustomer(customerQuery),
        this.nmsTools?.isConfigured ? this.nmsTools.cekPelanggan(customerQuery).catch(() => null) : Promise.resolve(null),
      ]);
      const parts = [formatCustomerLookupPlainText(lookup)];
      if (nmsLookup && nmsLookup.items.length > 0) {
        parts.push('', nmsLookup.formattedText);
      }
      const reply = parts.join('\n');
      const result = {
        reply,
        source: nmsLookup && nmsLookup.items.length > 0 ? 'SPV NOC · MikroTik + ADT NMS OLT' : 'SPV NOC · Live Customer Scanner',
      };
      if (this.aiBridge) {
        await this.aiBridge.appendConversation('spv-noc', question, result.reply, result.source, userSource);
      }
      if (this.aiMemoryStore) {
        await this.aiMemoryStore.recordConversation(userSource, question, result.reply, result.source);
      }
      this.broadcast();
      return result;
    }

    const snapshot = this.buildSnapshot();
    const pending = this.approvalStore.getAll().filter((a) => a.status === 'PENDING');
    const memoryContext = this.aiMemoryStore?.retrieveRelevantContext(question);
    const patternContext = this.trafficPatternLearner?.buildFleetPatternContext(snapshot.agents);
    const result = await generateSpvFleetAnswer({
      agents: snapshot.agents,
      externalPings: this.externalPings,
      reports: this.spvReports,
      pendingApprovals: pending,
      topologyLinks: snapshot.topologyLinks,
      memoryContext,
      patternContext,
      question,
      focusRouterId,
    });
    if (this.aiBridge) {
      await this.aiBridge.appendConversation('spv-noc', question, result.reply, result.source, userSource);
    }
    if (this.aiMemoryStore) {
      await this.aiMemoryStore.recordConversation(userSource, question, result.reply, result.source);
    }
    this.broadcast();
    return result;
  }

  async addTopologyLink(input: NewTopologyLinkInput): Promise<TopologyLink> {
    if (!this.topologyStore) {
      throw new Error('Topology store belum diaktifkan');
    }
    const created = await this.topologyStore.addLink(input);
    this.broadcast();
    return created;
  }

  async deleteTopologyLink(linkId: string): Promise<void> {
    if (!this.topologyStore) {
      throw new Error('Topology store belum diaktifkan');
    }
    await this.topologyStore.deleteLink(linkId);
    this.broadcast();
  }

  async saveTopologyPositions(positions: readonly TopologyNodePosition[]): Promise<void> {
    if (!this.topologyStore) {
      throw new Error('Topology store belum diaktifkan');
    }
    await this.topologyStore.savePositions(positions);
    this.broadcast();
  }

  async addAiMemoryFact(text: string, source = 'Boss / Admin', topic = 'SOP & Topologi'): Promise<AiLearnedFact> {
    if (!this.aiMemoryStore) {
      throw new Error('AI Memory store belum diaktifkan');
    }
    const fact = await this.aiMemoryStore.addFact(text, source, topic);
    this.broadcast();
    return fact;
  }

  async deleteAiMemoryFact(factId: string): Promise<void> {
    if (!this.aiMemoryStore) {
      throw new Error('AI Memory store belum diaktifkan');
    }
    await this.aiMemoryStore.deleteFact(factId);
    this.broadcast();
  }

  async sendSpvSummaryWhatsapp(targetOverride?: string): Promise<{ readonly ok: boolean; readonly detail: string }> {
    if (!this.fonnteNotifier) {
      return { ok: false, detail: 'Notifier WhatsApp belum diaktifkan' };
    }
    const snapshot = this.buildSnapshot();
    const patternContext = this.trafficPatternLearner?.buildFleetPatternContext(snapshot.agents);
    const summaryText = await composeSpvExecutiveReport({
      agents: snapshot.agents,
      externalPings: this.externalPings,
      reports: this.spvReports,
      isDailyReport: false,
      patternContext,
      useAiConclusion: true,
    });
    const target = (targetOverride ?? this.fonnteNotifier.getSettings().waTarget).trim();
    const res = await this.fonnteNotifier.sendRaw(target, summaryText);
    if (res.ok) {
      this.recordSpvReport({
        routerId: 'spv-noc',
        routerName: 'SEMUA ROUTER',
        agentName: 'SPV NOC',
        severity: 'info',
        category: 'recovery',
        message: 'Laporan ringkas rapi beserta kesimpulan SPV AI dikirim ke WhatsApp.',
        sentToWa: true,
      });
      this.broadcast();
    }
    return res;
  }

  private recordSpvReport(entry: Omit<SpvReportEntry, 'id' | 'timestamp'>): void {
    const item: SpvReportEntry = {
      id: crypto.randomUUID().slice(0, 8),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.spvReports = [item, ...this.spvReports].slice(0, 50);
  }

  getAlertSettings(): (AlertSettings & { readonly waTokenConfigured: boolean }) | undefined {
    if (!this.fonnteNotifier) return undefined;
    return {
      ...this.fonnteNotifier.getSettings(),
      waTokenConfigured: this.fonnteNotifier.hasToken,
    };
  }

  async updateAlertSettings(patch: Partial<AlertSettings>): Promise<AlertSettings & { readonly waTokenConfigured: boolean }> {
    if (!this.fonnteNotifier) {
      throw new Error('Notifier WhatsApp belum diaktifkan');
    }
    const updated = await this.fonnteNotifier.updateSettings(patch);
    this.broadcast();
    return { ...updated, waTokenConfigured: this.fonnteNotifier.hasToken };
  }

  async sendTestWhatsapp(targetOverride?: string): Promise<{ readonly ok: boolean; readonly detail: string }> {
    if (!this.fonnteNotifier) {
      return { ok: false, detail: 'Notifier WhatsApp belum diaktifkan' };
    }
    return this.fonnteNotifier.sendTest(targetOverride);
  }

  async pushAntigravityReport(
    routerId: string,
    briefing: string,
    detailMessage: string,
    agentLabel?: string,
  ): Promise<void> {
    const router = this.routers.find((r) => r.id === routerId);
    if (!router) {
      throw new Error(`Router ${routerId} tidak ditemukan`);
    }
    if (this.aiBridge) {
      await this.aiBridge.recordBridgeReport(routerId, briefing, detailMessage, agentLabel);
    }
    this.broadcast();
  }

  private resolveReadSecret(router: RouterDevice, overridePassword?: string): string | undefined {
    if (overridePassword !== undefined && overridePassword !== '') {
      return overridePassword;
    }
    if (router.readPasswordEnc) {
      return this.secretVault ? this.secretVault.decrypt(router.readPasswordEnc) : router.readPasswordEnc;
    }
    const envSecret = (process.env[router.readSecretEnv] ?? process.env.MT_READ_SECRET ?? '').trim();
    return envSecret || undefined;
  }

  async addRouter(input: NewRouterInput): Promise<RouterDevice> {
    if (this.routers.length >= 24) {
      throw new Error('Batas maksimum 24 router dalam satu Kantor 3D tercapai');
    }
    const existingIds = new Set(this.routers.map((r) => r.id));
    const id = slugifyRouterId(input.name, existingIds);
    const slot = allocateDeskSlot(this.routers, input.room);

    const readPasswordEnc =
      input.readPassword && input.readPassword.length > 0
        ? this.secretVault
          ? this.secretVault.encrypt(input.readPassword)
          : input.readPassword
        : undefined;

    const created: RouterDevice = {
      id,
      name: input.name,
      deviceModel: input.deviceModel?.trim() || (input.routerOsVersion === 'v7' ? 'MikroTik ROS v7' : 'MikroTik ROS v6'),
      host: input.host,
      port: input.port,
      useTls: input.useTls,
      routerOsVersion: input.routerOsVersion,
      role: input.role,
      agentName: input.agentName?.trim() || `Agen (${input.name.slice(0, 18)})`,
      agentColor: slot.color,
      room: input.room,
      deskX: slot.deskX,
      deskZ: slot.deskZ,
      readUsername: input.readUsername,
      readSecretEnv: 'MT_READ_SECRET',
      ...(readPasswordEnc ? { readPasswordEnc } : {}),
      execUsername: 'ai_executor',
      execSecretEnv: 'MT_EXEC_SECRET',
      simulated: input.simulated,
    };

    const nextRouters = [...this.routers, created];
    this.routers = nextRouters;
    if (this.onPersistRouters) {
      await this.onPersistRouters(nextRouters);
    }

    const tel = await pollRouterTelemetry(created, false, this.resolveReadSecret(created));
    this.recordTelemetry(tel);
    this.broadcast();
    return created;
  }

  async deleteRouter(routerId: string): Promise<void> {
    if (this.routers.length <= 1) {
      throw new Error('Minimal harus ada 1 router yang dipantau');
    }
    const exists = this.routers.some((r) => r.id === routerId);
    if (!exists) {
      throw new Error(`Router ${routerId} tidak ditemukan`);
    }
    const nextRouters = this.routers.filter((r) => r.id !== routerId);
    this.routers = nextRouters;
    sharedRouterOsPool.invalidate(routerId);
    this.linkWatchdog.clearRouter(routerId);
    this.pppoeWatchdog.clearRouter(routerId);
    await this.topologyStore?.pruneDeletedRouter(routerId);
    this.telemetryMap.delete(routerId);
    this.pingMap.delete(routerId);
    this.interfacePingMap.delete(routerId);
    this.historyMap.delete(routerId);
    this.logsMap.delete(routerId);
    this.cooldownMap.delete(routerId);

    if (this.onPersistRouters) {
      await this.onPersistRouters(nextRouters);
    }
    this.broadcast();
  }

  async updateRouter(routerId: string, patch: RouterUpdatePatch): Promise<RouterDevice> {
    const existing = this.routers.find((r) => r.id === routerId);
    if (!existing) {
      throw new Error(`Router ${routerId} tidak ditemukan`);
    }

    let nextPasswordEnc = existing.readPasswordEnc;
    if (patch.clearReadPassword) {
      nextPasswordEnc = undefined;
    } else if (patch.readPassword !== undefined && patch.readPassword.length > 0) {
      nextPasswordEnc = this.secretVault ? this.secretVault.encrypt(patch.readPassword) : patch.readPassword;
    }

    const baseWithoutEnc: RouterDevice = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.agentName !== undefined ? { agentName: patch.agentName } : {}),
      ...(patch.dutyRole !== undefined ? { dutyRole: patch.dutyRole } : {}),
      ...(patch.dutyLabel !== undefined ? { dutyLabel: patch.dutyLabel } : {}),
      ...(patch.watchedInterfaces !== undefined ? { watchedInterfaces: patch.watchedInterfaces } : {}),
      ...(patch.trafficDropThresholdPct !== undefined ? { trafficDropThresholdPct: patch.trafficDropThresholdPct } : {}),
      ...(patch.minTrafficMbps !== undefined ? { minTrafficMbps: patch.minTrafficMbps } : {}),
      ...(patch.interfacePing !== undefined ? { interfacePing: patch.interfacePing } : {}),
      ...(patch.customPrompt !== undefined ? { customPrompt: patch.customPrompt } : {}),
      ...(patch.host !== undefined ? { host: patch.host } : {}),
      ...(patch.port !== undefined ? { port: patch.port } : {}),
      ...(patch.useTls !== undefined ? { useTls: patch.useTls } : {}),
      ...(patch.routerOsVersion !== undefined ? { routerOsVersion: patch.routerOsVersion } : {}),
      ...(patch.readUsername !== undefined ? { readUsername: patch.readUsername } : {}),
      ...(patch.simulated !== undefined ? { simulated: patch.simulated } : {}),
    };
    const { readPasswordEnc: _dropped, ...cleanBase } = baseWithoutEnc;
    const updated: RouterDevice = nextPasswordEnc ? { ...cleanBase, readPasswordEnc: nextPasswordEnc } : cleanBase;

    const nextRouters = this.routers.map((r) => (r.id === routerId ? updated : r));
    this.routers = nextRouters;
    const connChanged =
      patch.host !== undefined ||
      patch.port !== undefined ||
      patch.useTls !== undefined ||
      patch.readUsername !== undefined ||
      patch.readPassword !== undefined ||
      patch.clearReadPassword === true ||
      patch.simulated !== undefined;
    if (connChanged) {
      sharedRouterOsPool.invalidate(routerId);
    }
    if (patch.interfacePing !== undefined) {
      this.interfacePingMap.delete(routerId);
    }
    if (patch.watchedInterfaces !== undefined || patch.dutyRole !== undefined) {
      this.linkWatchdog.clearRouter(routerId);
    }

    if (this.onPersistRouters) {
      await this.onPersistRouters(nextRouters);
    }

    const tel = await pollRouterTelemetry(updated, false, this.resolveReadSecret(updated));
    this.recordTelemetry(tel);
    this.broadcast();
    return updated;
  }

  async testRouterConnection(routerId: string, override?: RouterUpdatePatch): Promise<RouterTelemetry> {
    const existing = this.routers.find((r) => r.id === routerId);
    if (!existing) {
      throw new Error(`Router ${routerId} tidak ditemukan`);
    }

    const candidate: RouterDevice = {
      ...existing,
      ...(override?.name !== undefined ? { name: override.name } : {}),
      ...(override?.host !== undefined ? { host: override.host } : {}),
      ...(override?.port !== undefined ? { port: override.port } : {}),
      ...(override?.useTls !== undefined ? { useTls: override.useTls } : {}),
      ...(override?.routerOsVersion !== undefined ? { routerOsVersion: override.routerOsVersion } : {}),
      ...(override?.readUsername !== undefined ? { readUsername: override.readUsername } : {}),
      simulated: false,
    };

    const effectiveSecret = override?.clearReadPassword
      ? undefined
      : this.resolveReadSecret(existing, override?.readPassword);
    return pollRouterTelemetry(candidate, true, effectiveSecret);
  }

  resolveRouterIdBySource(ip: string, hostname?: string): string {
    const byIp = this.routers.find((r) => r.host === ip);
    if (byIp) return byIp.id;
    if (hostname) {
      const lower = hostname.toLowerCase();
      const byName = this.routers.find((r) => r.name.toLowerCase() === lower || r.id.toLowerCase() === lower);
      if (byName) return byName.id;
    }
    return 'unmatched';
  }

  async start(pollIntervalMs = 3000): Promise<void> {
    await this.pollAllRouters();
    this.telegramBot.start();
    this.pollTimer = setInterval(() => {
      void this.pollAllRouters();
    }, Math.max(1500, pollIntervalMs));

    // Start continuous background Ping monitor (every 10s, non-overlapping)
    void this.runPingSweep();
    const pingIntervalMs = Math.max(5000, Number(process.env.PING_INTERVAL_MS ?? '10000'));
    this.pingTimer = setInterval(() => {
      void this.runPingSweep();
    }, pingIntervalMs);

    // Check every 60s for 1x Daily Scheduled WhatsApp Report & 02:00 Daily MikroTik .rsc Backup
    this.dailyReportTimer = setInterval(() => {
      void this.checkAndSendDailyReport();
      if (this.rscBackupManager?.shouldRunDailyBackup(new Date(), 2)) {
        void this.runRscBackupNow();
      }
    }, 60_000);

    // Seed initial MikroTik .rsc folder 15s after startup if no backup exists yet
    if (this.rscBackupManager && this.rscBackupManager.getSummary().entries.length === 0) {
      this.rscInitTimer = setTimeout(() => {
        void this.runRscBackupNow();
      }, 15_000);
    }
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.dailyReportTimer) {
      clearInterval(this.dailyReportTimer);
      this.dailyReportTimer = null;
    }
    if (this.rscInitTimer) {
      clearTimeout(this.rscInitTimer);
      this.rscInitTimer = null;
    }
    if (this.incidentBatchTimer) {
      clearTimeout(this.incidentBatchTimer);
      this.incidentBatchTimer = null;
    }
    if (this.recoveryBatchTimer) {
      clearTimeout(this.recoveryBatchTimer);
      this.recoveryBatchTimer = null;
    }
    void this.trafficPatternLearner?.flush();
    sharedRouterOsPool.closeAll();
    this.telegramBot.stop();
  }

  private getPingThresholds(isExternal = false): PingThresholds {
    const s = this.fonnteNotifier?.getSettings();
    const localWarn = s?.pingWarnMs ?? 50;
    const localCrit = s?.pingCritMs ?? 100;
    const extCrit = s?.extPingCritMs ?? 150;
    const lossCrit = s?.pingLossCritPct ?? 40;
    if (isExternal) {
      return {
        warnMs: Math.max(80, localWarn),
        critMs: Math.max(100, extCrit),
        lossCritPct: lossCrit,
      };
    }
    return {
      warnMs: localWarn,
      critMs: localCrit,
      lossCritPct: lossCrit,
    };
  }

  async checkAndSendDailyReport(now = new Date()): Promise<boolean> {
    if (!this.fonnteNotifier?.shouldSendDailyReport(now)) {
      return false;
    }
    const snapshot = this.buildSnapshot();
    const patternContext = this.trafficPatternLearner?.buildFleetPatternContext(snapshot.agents, now);
    const reportText = await composeSpvExecutiveReport({
      agents: snapshot.agents,
      externalPings: this.externalPings,
      reports: this.spvReports,
      isDailyReport: true,
      patternContext,
      useAiConclusion: true,
    });
    const target = this.fonnteNotifier.getSettings().waTarget.trim();
    const res = await this.fonnteNotifier.sendRaw(target, reportText);
    if (res.ok) {
      await this.fonnteNotifier.markDailyReportSent(now);
      void this.telegramBot.sendPlainAlert(reportText);
      this.recordSpvReport({
        routerId: 'spv-noc',
        routerName: 'LAPORAN HARIAN',
        agentName: 'SPV NOC',
        severity: 'info',
        category: 'recovery',
        message: 'Laporan harian rapi + analisa pola bandwidth SPV AI terkirim ke WhatsApp & Telegram.',
        sentToWa: true,
      });
      this.broadcast();
      return true;
    }
    return false;
  }

  /**
   * Active pre-send verification & 45-second consolidation bundler:
   * - Re-tests live router/ping before escalating so transient 2-3s glitches NEVER trigger WA.
   * - Bundles simultaneous upstream/downstream events into ONE neat report concluded by SPV AI!
   */
  private async verifyAndQueueIncident(
    router: RouterDevice,
    candidate: Omit<VerifiedIncidentItem, 'verificationNote' | 'detectedAt'> & {
      readonly checkInterfaceDown?: string;
      readonly isTrafficDropOnly?: boolean;
    },
  ): Promise<void> {
    if (!this.fonnteNotifier) return;
    if (!this.fonnteNotifier.canDispatchIncidentKey(candidate.key)) {
      this.fonnteNotifier.markIncidentActive(candidate.key);
      return;
    }
    if (this.pendingIncidentsMap.has(candidate.key)) {
      return;
    }

    // Active Verification Re-Test (wait 2s, then run live ping + API re-check!)
    await new Promise((r) => setTimeout(r, 2000));
    const pingTest = await runSinglePing(router.host, router.name, this.getPingThresholds(false));

    // If this was only a traffic-drop candidate (link still UP), NEVER alert WA unless active ping ALSO degraded!
    if (candidate.isTrafficDropOnly) {
      if (pingTest.status === 'ok' || pingTest.status === 'high') {
        return;
      }
    }

    let verificationNote =
      pingTest.avgMs !== null
        ? `Tes ulang Ping ${router.host}: ${pingTest.avgMs} ms (loss ${pingTest.packetLossPercent}%)`
        : `Tes ulang Ping ${router.host}: RTO 100% tidak merespons`;

    if (candidate.category === 'offline' || candidate.checkInterfaceDown) {
      const reTel = await pollRouterTelemetry(router, true, this.resolveReadSecret(router));
      if (candidate.category === 'offline' && reTel.reachable) {
        // Recovered on active re-test -> cancel false alarm!
        return;
      }
      if (candidate.checkInterfaceDown && reTel.reachable) {
        const targetIf = reTel.interfaces.find(
          (i) => i.name.toLowerCase() === candidate.checkInterfaceDown!.toLowerCase(),
        );
        if (targetIf?.running) {
          // Link came back UP on active re-test -> cancel false alarm!
          return;
        }
        verificationNote = `Tes ulang API memastikan port ${candidate.checkInterfaceDown} masih DOWN`;
      }
    }

    const verifiedItem: VerifiedIncidentItem = {
      key: candidate.key,
      category: candidate.category,
      routerId: router.id,
      routerName: router.name,
      agentName: router.agentName,
      headline: candidate.headline,
      verificationNote,
      detectedAt: new Date().toISOString(),
    };

    this.pendingIncidentsMap.set(candidate.key, verifiedItem);
    if (!this.incidentBatchTimer) {
      // Consolidate correlated events for 35s so 1 upstream cut + 3 downstream alerts merge into 1 neat SPV AI report!
      this.incidentBatchTimer = setTimeout(() => {
        this.incidentBatchTimer = null;
        void this.flushIncidentBatch();
      }, 35_000);
    }
  }

  private async flushIncidentBatch(): Promise<void> {
    if (!this.fonnteNotifier || this.pendingIncidentsMap.size === 0) return;
    const batch = Array.from(this.pendingIncidentsMap.values());
    this.pendingIncidentsMap.clear();

    const snapshot = this.buildSnapshot();
    const patternContext = this.trafficPatternLearner?.buildFleetPatternContext(snapshot.agents);
    const reportText = await composeSpvVerifiedIncidentReport({
      incidents: batch,
      agents: snapshot.agents,
      topologyLinks: snapshot.topologyLinks,
      patternContext,
    });

    const keys = batch.map((b) => b.key);
    const sent = await this.fonnteNotifier.sendBundledAlerts(keys, reportText);
    if (sent) {
      void this.telegramBot.sendPlainAlert(reportText);
    }
    for (const b of batch) {
      this.recordSpvReport({
        routerId: b.routerId,
        routerName: b.routerName,
        agentName: b.agentName,
        severity: 'critical',
        category: b.category,
        message: `${b.headline} (${b.verificationNote})`,
        sentToWa: sent,
      });
    }
    this.broadcast();
  }

  private queueRecoveryNotification(item: {
    readonly key: string;
    readonly routerId: string;
    readonly routerName: string;
    readonly agentName: string;
    readonly detail: string;
  }): void {
    if (!this.fonnteNotifier?.hasActiveIncident(item.key)) return;
    this.pendingRecoveriesMap.set(item.key, item);
    if (!this.recoveryBatchTimer) {
      this.recoveryBatchTimer = setTimeout(() => {
        this.recoveryBatchTimer = null;
        void this.flushRecoveryBatch();
      }, 20_000);
    }
  }

  private async flushRecoveryBatch(): Promise<void> {
    if (!this.fonnteNotifier || this.pendingRecoveriesMap.size === 0) return;
    const items = Array.from(this.pendingRecoveriesMap.values());
    this.pendingRecoveriesMap.clear();

    const activeKeys = this.fonnteNotifier.consumeActiveRecoveryKeys(items.map((i) => i.key));
    if (activeKeys.length === 0) return;
    const activeSet = new Set(activeKeys);
    const confirmedItems = items.filter((i) => activeSet.has(i.key));
    if (confirmedItems.length === 0) return;

    const msg = composeSpvRecoveryReport(confirmedItems);
    let sentWa = false;
    if (this.fonnteNotifier.getSettings().waEnabled && this.fonnteNotifier.isConfigured) {
      const res = await this.fonnteNotifier.sendRaw(this.fonnteNotifier.getSettings().waTarget, msg);
      sentWa = res.ok;
    }
    if (sentWa) {
      void this.telegramBot.sendPlainAlert(msg);
    }
    for (const it of confirmedItems) {
      this.recordSpvReport({
        routerId: it.routerId,
        routerName: it.routerName,
        agentName: it.agentName,
        severity: 'info',
        category: 'recovery',
        message: it.detail,
        sentToWa: sentWa,
      });
    }
    this.broadcast();
  }

  async runPingSweep(): Promise<void> {
    if (this.pinging) return;
    this.pinging = true;
    try {
      const localThresholds = this.getPingThresholds(false);
      const extThresholds = this.getPingThresholds(true);
      const liveRouters = this.routers.filter((r) => !r.simulated);

      const [routerPings, extPings] = await Promise.all([
        Promise.all(
          liveRouters.map(async (r) => ({
            router: r,
            metric: await runSinglePing(r.host, r.name, localThresholds),
          })),
        ),
        Promise.all(
          this.externalPingTargets.map((target) =>
            runSinglePing(
              target,
              target === '1.1.1.1' ? 'Cloudflare DNS' : target === '8.8.8.8' ? 'Google DNS' : target,
              extThresholds,
            ),
          ),
        ),
      ]);

      for (const { router, metric } of routerPings) {
        this.pingMap.set(router.id, metric);
        await this.evaluatePingWhatsappAlert(
          `ping:router:${router.id}`,
          router.id,
          router.name,
          router.agentName,
          metric,
          localThresholds,
        );
      }

      this.externalPings = extPings;
      for (const ep of extPings) {
        await this.evaluatePingWhatsappAlert(
          `ping:ext:${ep.target}`,
          'spv-noc',
          `Internet ${ep.label}`,
          'SPV NOC · Ping Sensor',
          ep,
          extThresholds,
        );
      }

      // Run in-router interface ping (e.g., CORE MONGKONAI `/ping 1.1.1.1 interface=vlan2000-CMK`)
      // on first sweep and every 2nd sweep (~20s) using the persistent 1x-login session pool!
      this.pingSweepTick += 1;
      const shouldRunIfPing = this.pingSweepTick === 1 || this.pingSweepTick % 2 === 1;
      if (shouldRunIfPing) {
        const ifPingRouters = liveRouters.filter((r) => resolveRouterDutyProfile(r).interfacePing !== null);
        const ifPingResults = await Promise.all(
          ifPingRouters.map(async (r) => ({
            router: r,
            cfg: resolveRouterDutyProfile(r).interfacePing!,
            metric: await pollRouterInterfacePing(r, this.resolveReadSecret(r), extThresholds),
          })),
        );
        for (const { router, cfg, metric } of ifPingResults) {
          if (!metric) continue;
          this.interfacePingMap.set(router.id, metric);
          const customTh: PingThresholds = {
            warnMs: cfg.warnMs ?? extThresholds.warnMs,
            critMs: cfg.critMs ?? extThresholds.critMs,
            lossCritPct: extThresholds.lossCritPct,
          };
          await this.evaluatePingWhatsappAlert(
            `ping:ifping:${router.id}:${cfg.interfaceName}`,
            router.id,
            `${router.name} via ${cfg.interfaceName}`,
            router.agentName,
            metric,
            customTh,
          );
        }
      }

      this.broadcast();
    } finally {
      this.pinging = false;
    }
  }

  /**
   * Strict anti-spam Ping alert evaluator:
   * - 'high' (warning) NEVER triggers WhatsApp (visible on Dashboard & Daily Report only).
   * - 'critical' or 'down' MUST persist for `pingConfirmCount` consecutive checks (default 3x = ~30s) before sending WA.
   * - Recovery WA is sent ONLY if a critical WA was previously sent AND ping returns 'ok' for 3x consecutive checks.
   */
  async evaluatePingWhatsappAlert(
    incidentKey: string,
    routerId: string,
    routerName: string,
    agentName: string,
    metric: PingMetric,
    thresholds: PingThresholds,
  ): Promise<boolean> {
    if (!this.fonnteNotifier) return false;
    const requiredConfirm = Math.max(1, this.fonnteNotifier.getSettings().pingConfirmCount ?? 3);

    if (metric.status === 'critical' || metric.status === 'down') {
      this.pingOkStreakMap.set(incidentKey, 0);
      const streak = (this.pingFailStreakMap.get(incidentKey) ?? 0) + 1;
      this.pingFailStreakMap.set(incidentKey, streak);

      // Ignore transient 1x-2x glitches; only notify WA once sustained!
      if (streak < requiredConfirm) {
        return false;
      }

      const title =
        metric.status === 'down'
          ? 'LAPORAN PING TERPUTUS (RTO) — SPV NOC'
          : 'LAPORAN LATENSI KRITIS — SPV NOC';
      const rttDetail =
        metric.avgMs !== null
          ? `Rata-rata ${metric.avgMs} ms (maks ${metric.maxMs} ms) · Loss ${metric.packetLossPercent}%`
          : `RTO 100% tidak merespons`;
      const msg = [
        title,
        `${new Date().toLocaleString('id-ID')}`,
        `━━━━━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `TEMUAN SENSOR PING (${streak}X CEK BERTURUT-TURUT)`,
        `• Perangkat : ${routerName} (${metric.target})`,
        `• Penjaga   : ${agentName}`,
        `• Hasil Tes : ${rttDetail}`,
        ``,
        `KESIMPULAN ANALISA SPV AI`,
        metric.status === 'down'
          ? `Target ${routerName} tidak merespons dalam ${streak} pengujian berturut-turut. Periksa jalur transmisi atau perangkat hulu.`
          : `Latensi atau packet loss pada ${routerName} melampaui batas kritis (≥ ${thresholds.critMs} ms / loss ≥ ${thresholds.lossCritPct}%) secara konsisten.`,
      ].join('\n');
      const sent = await this.fonnteNotifier.sendAlertWithCooldown(incidentKey, msg);
      if (sent) {
        void this.telegramBot.sendPlainAlert(msg);
        this.recordSpvReport({
          routerId,
          routerName,
          agentName,
          severity: 'critical',
          category: 'ping',
          message:
            metric.avgMs !== null
              ? `Ping KRITIS ${metric.avgMs} ms (loss ${metric.packetLossPercent}%, ${streak}x berturut-turut)`
              : `Ping RTO / 100% loss pada ${metric.target} (${streak}x berturut-turut)`,
          sentToWa: true,
        });
      }
      return sent;
    }

    // For 'high' (minor fluctuation) or 'ok': reset critical fail streak
    this.pingFailStreakMap.set(incidentKey, 0);

    if (metric.status === 'ok' && this.fonnteNotifier.hasActiveIncident(incidentKey)) {
      const okStreak = (this.pingOkStreakMap.get(incidentKey) ?? 0) + 1;
      this.pingOkStreakMap.set(incidentKey, okStreak);
      if (okStreak < requiredConfirm) {
        return false;
      }
      this.pingOkStreakMap.set(incidentKey, 0);

      const recoveryMsg = composeSpvRecoveryReport([
        {
          routerName,
          agentName,
          detail: `Ping kembali stabil (${metric.avgMs ?? 0} ms · loss ${metric.packetLossPercent}%)`,
        },
      ]);
      const sentRec = await this.fonnteNotifier.sendRecoveryIfActive(incidentKey, recoveryMsg);
      if (sentRec) {
        void this.telegramBot.sendPlainAlert(recoveryMsg);
        this.recordSpvReport({
          routerId,
          routerName,
          agentName,
          severity: 'info',
          category: 'recovery',
          message: `Ping pulih stabil (${metric.avgMs ?? 0} ms, loss ${metric.packetLossPercent}%)`,
          sentToWa: true,
        });
      }
      return sentRec;
    }

    return false;
  }

  async pollAllRouters(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const currentRouters = this.routers;
      const results = await Promise.all(
        currentRouters.map((r) => pollRouterWithLogs(r, false, this.resolveReadSecret(r))),
      );
      for (const { telemetry: tel, apiLogs } of results) {
        this.recordTelemetry(tel);
        if (apiLogs.length > 0) {
          await this.mergePolledLogs(tel.routerId, apiLogs);
        }
        const router = this.routers.find((r) => r.id === tel.routerId);
        if (router && !router.simulated && this.fonnteNotifier) {
          const confirmNeeded = Math.max(3, this.fonnteNotifier.getSettings().pingConfirmCount ?? 3);
          if (tel.status === 'offline') {
            this.resourceCritStreakMap.set(router.id, 0);
            const offStreak = (this.offlineStreakMap.get(router.id) ?? 0) + 1;
            this.offlineStreakMap.set(router.id, offStreak);
            if (offStreak >= confirmNeeded) {
              void this.verifyAndQueueIncident(router, {
                key: `offline:${router.id}`,
                category: 'offline',
                routerId: router.id,
                routerName: router.name,
                agentName: router.agentName,
                headline: `Router tidak terjangkau via API (${tel.lastError ?? 'Connection timeout'})`,
              });
            }
          } else {
            this.offlineStreakMap.set(router.id, 0);
            this.queueRecoveryNotification({
              key: `offline:${router.id}`,
              routerId: router.id,
              routerName: router.name,
              agentName: router.agentName,
              detail: `Router kembali ONLINE (CPU ${tel.cpuLoadPercent}% · Uptime ${tel.uptime})`,
            });

            // Only alert WA on SUSTAINED extreme hardware overload
            const extremeHw =
              tel.cpuLoadPercent >= 95 ||
              tel.memoryUsedPercent >= 95 ||
              (tel.temperatureC !== null && tel.temperatureC >= 78);
            if (extremeHw) {
              const hwStreak = (this.resourceCritStreakMap.get(router.id) ?? 0) + 1;
              this.resourceCritStreakMap.set(router.id, hwStreak);
              const requiredHwStreak = tel.temperatureC !== null && tel.temperatureC >= 78 ? 4 : 6;
              if (hwStreak >= requiredHwStreak) {
                void this.verifyAndQueueIncident(router, {
                  key: `critical:${router.id}`,
                  category: 'resource',
                  routerId: router.id,
                  routerName: router.name,
                  agentName: router.agentName,
                  headline: `Beban hardware sangat tinggi (CPU ${tel.cpuLoadPercent}% · RAM ${tel.memoryUsedPercent}%${tel.temperatureC !== null ? ` · Suhu ${tel.temperatureC}°C` : ''})`,
                });
              }
            } else {
              this.resourceCritStreakMap.set(router.id, 0);
            }

            // Evaluate Role-Specific Watched Links with 24h Bandwidth Pattern Learner!
            const { statuses: watchedStatuses, events: linkEvents } = this.linkWatchdog.evaluateRouterInterfaces(
              router,
              tel.interfaces,
              confirmNeeded,
              (ifName, mbps) => this.trafficPatternLearner?.isNormalBandwidthPattern(router.id, ifName, mbps) ?? false,
            );
            for (const ev of linkEvents) {
              if (ev.kind === 'down') {
                void this.verifyAndQueueIncident(router, {
                  key: ev.key,
                  category: 'link',
                  routerId: router.id,
                  routerName: router.name,
                  agentName: router.agentName,
                  headline: ev.message,
                  checkInterfaceDown: ev.interfaceName,
                });
              } else if (ev.kind === 'drop') {
                // Traffic drop while link is UP: ONLY escalate if active ping verification ALSO proves degradation!
                void this.verifyAndQueueIncident(router, {
                  key: ev.key,
                  category: 'link',
                  routerId: router.id,
                  routerName: router.name,
                  agentName: router.agentName,
                  headline: ev.message,
                  isTrafficDropOnly: true,
                });
              } else if (ev.kind === 'recovered') {
                this.queueRecoveryNotification({
                  key: ev.key,
                  routerId: router.id,
                  routerName: router.name,
                  agentName: router.agentName,
                  detail: ev.message,
                });
              }
            }

            // Evaluate Mass-Disconnect PPPoE Watchdog (Instant OLT / FO Distribution Cut Detection!)
            const minDropUsers = this.fonnteNotifier.getSettings().pppoeMassDropCount ?? 15;
            const massEvent = this.pppoeWatchdog.evaluate(
              router,
              tel.activePppoeCount,
              tel.interfaces,
              watchedStatuses,
              minDropUsers,
            );
            if (massEvent?.kind === 'mass_disconnect') {
              void this.verifyAndQueueIncident(router, {
                key: massEvent.key,
                category: 'pppoe_mass',
                routerId: router.id,
                routerName: router.name,
                agentName: router.agentName,
                headline: massEvent.message,
              });
            } else if (massEvent?.kind === 'recovered') {
              this.queueRecoveryNotification({
                key: massEvent.key,
                routerId: router.id,
                routerName: router.name,
                agentName: router.agentName,
                detail: massEvent.message,
              });
            }

            // Evaluate SFP Optical RX/TX Power Watchdog across ALL CRS Backbones & Routers!
            if (tel.sfpOptics && tel.sfpOptics.length > 0) {
              const sfpCritDbm = this.fonnteNotifier.getSettings().sfpRxCritDbm ?? -24;
              const { updatedOptics, events: sfpEvents } = this.sfpWatchdog.evaluate(
                router,
                tel.sfpOptics,
                sfpCritDbm,
                confirmNeeded,
              );
              this.sfpOpticsMap.set(router.id, updatedOptics);

              for (const sev of sfpEvents) {
                if (sev.kind === 'high_attenuation' || sev.kind === 'los') {
                  void this.verifyAndQueueIncident(router, {
                    key: sev.key,
                    category: 'sfp',
                    routerId: router.id,
                    routerName: router.name,
                    agentName: router.agentName,
                    headline: sev.message,
                  });
                } else if (sev.kind === 'recovered') {
                  this.queueRecoveryNotification({
                    key: sev.key,
                    routerId: router.id,
                    routerName: router.name,
                    agentName: router.agentName,
                    detail: sev.message,
                  });
                }
              }
            }
          }
        }
        if (tel.status === 'critical' || tel.status === 'offline') {
          if (router) {
            await this.triggerAgentInvestigation(router);
          }
        }
      }
      await this.trafficPatternLearner?.observeFleet(currentRouters, this.telemetryMap);
      this.broadcast();
    } finally {
      this.polling = false;
    }
  }

  private async mergePolledLogs(routerId: string, apiLogs: readonly SyslogEntry[]): Promise<void> {
    const fresh: SyslogEntry[] = [];
    for (const entry of apiLogs) {
      if (this.seenLogIds.has(entry.id)) continue;
      this.seenLogIds.add(entry.id);
      fresh.push(entry);
    }
    if (this.seenLogIds.size > 4000) {
      const keep = Array.from(this.seenLogIds).slice(-2000);
      this.seenLogIds.clear();
      for (const id of keep) this.seenLogIds.add(id);
    }
    if (fresh.length === 0) return;

    const prev = this.logsMap.get(routerId) ?? [];
    this.logsMap.set(routerId, [...fresh, ...prev].slice(0, 60));
    this.globalLogs = [...fresh, ...this.globalLogs].slice(0, MAX_GLOBAL_LOGS);

    const freshRadius = fresh.filter((e) => isRadiusTimeoutMessage(e.message));
    const hasRadiusOrAnomaly = freshRadius.length > 0 || fresh.some((e) => isAnomalySyslog(e));
    if (hasRadiusOrAnomaly) {
      const router = this.routers.find((r) => r.id === routerId);
      if (router) {
        if (freshRadius[0] && !router.simulated && this.fonnteNotifier) {
          // Only escalate RADIUS timeout to WA if >= 3 timeouts happen within 2 minutes (real outage, not 1 stray packet!)
          const nowMs = Date.now();
          const prevHits = (this.radiusBurstMap.get(router.id) ?? []).filter((ts) => nowMs - ts < 120_000);
          const nextHits = [...prevHits, ...freshRadius.map(() => nowMs)];
          this.radiusBurstMap.set(router.id, nextHits);

          if (nextHits.length >= 4) {
            const failedUser = parseRadiusTimeoutUser(freshRadius[0].message) ?? 'unknown';
            void this.verifyAndQueueIncident(router, {
              key: `radius:${router.id}`,
              category: 'radius',
              routerId: router.id,
              routerName: router.name,
              agentName: router.agentName,
              headline: `RADIUS Timeout beruntun (${nextHits.length}x dalam 2 menit · user contoh: "${failedUser}")`,
            });
          }
        }
        await this.triggerAgentInvestigation(router, freshRadius.length > 0);
      }
    }
  }

  async ingestSyslog(entry: SyslogEntry): Promise<void> {
    this.globalLogs = [entry, ...this.globalLogs].slice(0, MAX_GLOBAL_LOGS);

    if (entry.routerId !== 'unmatched') {
      const prev = this.logsMap.get(entry.routerId) ?? [];
      const next = [entry, ...prev].slice(0, 40);
      this.logsMap.set(entry.routerId, next);

      if (isAnomalySyslog(entry)) {
        const router = this.routers.find((r) => r.id === entry.routerId);
        if (router) {
          await this.triggerAgentInvestigation(router, true);
        }
      }
    }
    this.broadcast();
  }

  async triggerAgentInvestigation(router: RouterDevice, bypassCooldown = false): Promise<ApprovalTicket | null> {
    const now = Date.now();
    const lastRun = this.cooldownMap.get(router.id) ?? 0;
    if (!bypassCooldown && now - lastRun < 60_000) {
      return null;
    }
    this.cooldownMap.set(router.id, now);

    const telemetry = this.telemetryMap.get(router.id) ?? null;
    const recentLogs = this.logsMap.get(router.id) ?? [];
    const diagnosis = await analyzeRouterIncident(router, telemetry, recentLogs, this.nocServerIp);

    if (diagnosis.requiresAction && diagnosis.proposal) {
      const { ticket, createdNew } = await this.approvalStore.createProposalTicket(
        router,
        diagnosis.incidentSummary,
        diagnosis.rootCauseAnalysis,
        diagnosis.proposal,
      );
      if (createdNew) {
        await this.telegramBot.sendApprovalRequestCard(ticket);
      }
      this.broadcast();
      return ticket;
    }

    this.broadcast();
    return null;
  }

  async approveAndExecute(ticketId: string, actor: string): Promise<ApprovalTicket> {
    const approved = await this.approvalStore.approveTicket(ticketId, actor);
    const router = this.routers.find((r) => r.id === approved.routerId);
    if (!router) {
      const failed = await this.approvalStore.markExecutionOutcome(ticketId, false, 'Router tidak ditemukan di inventaris');
      this.broadcast();
      return failed;
    }

    try {
      const output = await executeApprovedProposal(router, approved.proposal, this.nocServerIp);
      const executed = await this.approvalStore.markExecutionOutcome(ticketId, true, output);
      await this.telegramBot.sendExecutionUpdate(executed);
      this.broadcast();
      return executed;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal eksekusi RouterOS';
      const failed = await this.approvalStore.markExecutionOutcome(ticketId, false, message);
      await this.telegramBot.sendExecutionUpdate(failed);
      this.broadcast();
      return failed;
    }
  }

  async rejectProposal(ticketId: string, actor: string): Promise<ApprovalTicket> {
    const rejected = await this.approvalStore.rejectTicket(ticketId, actor);
    await this.telegramBot.sendExecutionUpdate(rejected);
    this.broadcast();
    return rejected;
  }

  buildSnapshot(): NocSnapshot {
    const allApprovals = this.approvalStore.getAll();
    const radiusAlerts: RadiusTimeoutAlert[] = [];

    const agents: OfficeAgentView[] = this.routers.map((r) => {
      const baseTel = this.telemetryMap.get(r.id) ?? null;
      const ping = this.pingMap.get(r.id) ?? null;
      const interfacePingResult = this.interfacePingMap.get(r.id) ?? null;
      const watchedLinks = this.linkWatchdog.getWatchedStatus(r.id);
      const pppoeDrop = this.pppoeWatchdog.getStatus(r.id);
      const sfpOptics = this.sfpOpticsMap.get(r.id) ?? baseTel?.sfpOptics;
      const tel: RouterTelemetry | null = baseTel
        ? { ...baseTel, ping, interfacePingResult, watchedLinks, pppoeDrop, ...(sfpOptics ? { sfpOptics } : {}) }
        : null;
      const duty = resolveRouterDutyProfile(r);
      const history = this.historyMap.get(r.id) ?? [];
      const logs = this.logsMap.get(r.id) ?? [];
      const pending = this.approvalStore.getPendingForRouter(r.id);

      const radiusLogs = logs.filter((l) => isRadiusTimeoutMessage(l.message));
      const radiusTimeoutCount = radiusLogs.length;
      if (radiusLogs[0]) {
        const failedUser = parseRadiusTimeoutUser(radiusLogs[0].message) ?? 'unknown';
        radiusAlerts.push({
          routerId: r.id,
          routerName: r.name,
          agentName: r.agentName,
          username: failedUser,
          message: radiusLogs[0].message,
          timestamp: radiusLogs[0].timestamp,
          count: radiusTimeoutCount,
        });
      }

      const hotspotFailures = logs
        .map((l) => parseHotspotFailedLogin(l))
        .filter((x): x is string => x !== null);
      const hotspotFailedLoginCount = hotspotFailures.length;
      const hotspotFailedUsers = Array.from(new Set(hotspotFailures)).slice(0, 10);

      const menunggu = pending.map((p) => `[#${p.id}] ${p.incidentSummary} → Setujui ${p.proposal.actionType}?`);
      const mendesak: string[] = [];

      if (radiusLogs[0]) {
        const failedUser = parseRadiusTimeoutUser(radiusLogs[0].message) ?? 'unknown';
        mendesak.push(`🚨 RADIUS TIMEOUT (${radiusTimeoutCount}x): user "${failedUser}" gagal autentikasi!`);
      }
      if (pppoeDrop?.activeIncident) {
        mendesak.push(
          `🚨 MASS-DISCONNECT PPPOE: -${pppoeDrop.droppedCount} user (${pppoeDrop.previousPeak} → ${pppoeDrop.currentCount})`,
        );
      }
      for (const wl of watchedLinks) {
        if (wl.state === 'down') {
          mendesak.push(`🔌 LINK ${wl.name} DOWN / PUTUS!`);
        } else if (wl.state === 'drop') {
          mendesak.push(`📉 TRAFIK ${wl.name} DROP ${wl.dropPercent}% (${wl.totalMbps} vs ${wl.baselineMbps} Mbps)`);
        }
      }
      for (const sfp of sfpOptics ?? []) {
        if (sfp.health === 'critical') {
          mendesak.push(
            `🌅 REDAMAN SFP KRITIS (${sfp.name}): RX ${sfp.rxPowerDbm ?? 'LOS'} dBm${sfp.temperatureC !== null ? ` · ${sfp.temperatureC}°C` : ''}`,
          );
        } else if (sfp.health === 'warning') {
          mendesak.push(
            `⚠️ REDAMAN SFP MULAI TINGGI (${sfp.name}): RX ${sfp.rxPowerDbm} dBm`,
          );
        }
      }
      if (interfacePingResult && (interfacePingResult.status === 'critical' || interfacePingResult.status === 'down')) {
        mendesak.push(
          interfacePingResult.avgMs !== null
            ? `🚨 PING ${interfacePingResult.label}: ${interfacePingResult.avgMs}ms · Loss ${interfacePingResult.packetLossPercent}%`
            : `❌ PING ${interfacePingResult.label}: RTO / PUTUS!`,
        );
      }
      if (ping && (ping.status === 'high' || ping.status === 'critical' || ping.status === 'down')) {
        mendesak.push(
          ping.avgMs !== null
            ? `🐢 PING MEMBENGKAK (${r.host}): avg ${ping.avgMs} ms / max ${ping.maxMs} ms · Loss ${ping.packetLossPercent}%`
            : `❌ PING RTO (${r.host}): 100% packet loss`,
        );
      }
      if (tel?.status === 'offline') {
        const errHint = tel.lastError ? ` · ${tel.lastError}` : '';
        mendesak.push(`${r.name} TIDAK TERJANGKAU (${r.host}:${r.port}${errHint})`);
      } else if (tel?.status === 'critical') {
        mendesak.push(`CPU ${tel.cpuLoadPercent}% / RAM ${tel.memoryUsedPercent}% kritis!`);
      }
      const critLogs = logs
        .filter((l) => !isRadiusTimeoutMessage(l.message) && (l.severity === 'critical' || l.severity === 'error'))
        .slice(0, 2);
      for (const cl of critLogs) {
        if (pending.length > 0 || mendesak.length === 0) {
          mendesak.push(cl.message.slice(0, 90));
        }
      }

      const bridgeState = this.aiBridge?.getState(r.id);
      const modeTag = r.simulated ? 'SIM' : 'LIVE';
      const badLink = watchedLinks.find((w) => w.state === 'down' || w.state === 'drop');
      let activity: OfficeAgentView['activity'] = 'kerja';
      let activityLabel = `${modeTag} · ${r.routerOsVersion}`;
      if (radiusTimeoutCount > 0) {
        activity = 'laporan';
        activityLabel = `🚨 RADIUS (${radiusTimeoutCount}x)`;
      } else if (badLink) {
        activity = 'laporan';
        activityLabel = badLink.state === 'down' ? `🔌 ${badLink.name.slice(0, 12)} DN` : `📉 ${badLink.name.slice(0, 10)} -${badLink.dropPercent}%`;
      } else if (interfacePingResult && (interfacePingResult.status === 'critical' || interfacePingResult.status === 'down')) {
        activity = 'laporan';
        activityLabel = interfacePingResult.avgMs !== null ? `🚨 VLAN ${interfacePingResult.avgMs}ms` : `❌ VLAN RTO`;
      } else if (ping && (ping.status === 'critical' || ping.status === 'down')) {
        activity = 'laporan';
        activityLabel = ping.avgMs !== null ? `🐢 ${ping.avgMs}ms` : `❌ RTO`;
      } else if (pending.length > 0) {
        activity = 'laporan';
        activityLabel = `🔒 ${pending.length} approval`;
      } else if (tel?.status === 'offline') {
        activity = 'kerja';
        activityLabel = `⚠ OFFLINE`;
      } else if (tel) {
        activity = 'kerja';
        const ifPingChip =
          interfacePingResult && interfacePingResult.avgMs !== null
            ? ` · V:${interfacePingResult.avgMs}ms`
            : ping && ping.avgMs !== null
              ? ` · ${ping.avgMs}ms`
              : '';
        activityLabel = `${modeTag} · ${tel.cpuLoadPercent}%${ifPingChip}`;
      }

      const ringkasan = radiusLogs[0]
        ? `🚨 RADIUS TIMEOUT: user "${parseRadiusTimeoutUser(radiusLogs[0].message) ?? 'unknown'}" gagal login (${radiusTimeoutCount}x)`
        : badLink
          ? `${badLink.state === 'down' ? '🔌 LINK DOWN' : '📉 DROP TRAFIK'}: ${badLink.name} (${badLink.totalMbps} Mbps)`
          : pending[0]
            ? `Menunggu Approval: ${pending[0].incidentSummary}`
            : tel
              ? `[${modeTag}] ${duty.dutyLabel} · CPU ${tel.cpuLoadPercent}%${
                  interfacePingResult?.avgMs !== null && interfacePingResult
                    ? ` · ${interfacePingResult.label}: ${interfacePingResult.avgMs}ms`
                    : tel.activePppoeCount > 0 || tel.activeHotspotCount > 0
                      ? ` · PPPoE ${tel.activePppoeCount} · HS ${tel.activeHotspotCount}`
                      : ''
                }`
              : `Menghubungi ${r.name} (${r.host})…`;

      const angka = [
        { label: `CPU ${r.name}`, nilai: tel ? `${tel.cpuLoadPercent}%` : '-' },
        ...(interfacePingResult
          ? [{ label: interfacePingResult.label, nilai: interfacePingResult.avgMs !== null ? `${interfacePingResult.avgMs}ms` : 'RTO' }]
          : []),
        ...(ping ? [{ label: `Ping ${r.name}`, nilai: ping.avgMs !== null ? `${ping.avgMs}ms` : 'RTO' }] : []),
        ...(tel && tel.activePppoeCount > 0 ? [{ label: `PPPoE ${r.name}`, nilai: `${tel.activePppoeCount} aktif` }] : []),
        ...(tel && tel.activeHotspotCount > 0 ? [{ label: `Hotspot ${r.name}`, nilai: `${tel.activeHotspotCount} aktif` }] : []),
        ...(r.role === 'core' && tel && tel.bgpPeersTotal > 0
          ? [{ label: `BGP ${r.name}`, nilai: `${tel.bgpPeersEstablished}/${tel.bgpPeersTotal} up` }]
          : []),
      ];

      return {
        key: r.id,
        routerId: r.id,
        nama: r.agentName,
        tugas: `${r.name} · ${duty.dutyLabel}`,
        ruang: r.room,
        warna: r.agentColor,
        x: r.deskX,
        z: r.deskZ,
        activity,
        activityLabel,
        ringkasan,
        menunggu,
        mendesak,
        angka,
        routerConfig: toPublicRouterConfig(r),
        telemetry: tel,
        telemetryHistory: history,
        recentLogs: logs.slice(0, 25),
        pendingApprovals: pending,
        radiusTimeoutCount,
        hotspotFailedLoginCount,
        hotspotFailedUsers,
        ...(bridgeState ? { aiBridge: bridgeState } : {}),
      };
    });

    const onlineCount = agents.filter((a) => a.telemetry?.reachable).length;
    const liveCount = this.routers.filter((r) => !r.simulated).length;
    const totalRadiusTimeouts = radiusAlerts.reduce((acc, a) => acc + a.count, 0);
    const totalHotspotActive = agents.reduce((acc, a) => acc + (a.telemetry?.activeHotspotCount ?? 0), 0);
    const pendingTotal = allApprovals.filter((a) => a.status === 'PENDING').length;
    const activeAlerts =
      agents.reduce((acc, a) => acc + a.mendesak.length, 0) +
      this.externalPings.filter((p) => p.status !== 'ok').length;
    const alertSettings = this.getAlertSettings();
    const spvBridge = this.aiBridge?.getState('spv-noc');
    const spvNoc: SpvNocState = {
      id: 'spv-noc',
      name: 'SPV NOC',
      role: 'AI Supervisor · Mengontrol Semua Agen & Router',
      linked: true,
      modelLabel: process.env.GEMINI_API_KEY?.trim()
        ? `Gemini Cloud (${process.env.GEMINI_MODEL?.trim() || 'gemini-flash-lite-latest'})`
        : 'Local Fleet AI',
      lastHeartbeatAt: spvBridge?.lastHeartbeatAt ?? new Date().toISOString(),
      totalRouters: this.routers.length,
      liveRouters: liveCount,
      activeAlerts,
      reports: this.spvReports.slice(0, 30),
      messages: spvBridge?.messages ?? [],
    };

    const enrichedTelemetryMap = new Map<string, RouterTelemetry>();
    for (const a of agents) {
      if (a.telemetry) enrichedTelemetryMap.set(a.routerId, a.telemetry);
    }
    const topologyLinks = this.topologyStore
      ? this.topologyStore.buildLiveLinks(this.routers, enrichedTelemetryMap)
      : [];
    const topologyPositions = this.topologyStore ? this.topologyStore.getPositions() : [];
    const aiMemory = this.aiMemoryStore
      ? this.aiMemoryStore.getSummary()
      : { totalConversations: 0, learnedFacts: [] };

    return {
      updatedAt: new Date().toISOString(),
      spvNoc,
      agents,
      topologyLinks,
      topologyPositions,
      aiMemory,
      ...(this.rscBackupManager ? { rscBackups: this.rscBackupManager.getSummary() } : {}),
      approvals: allApprovals.slice(0, 60),
      globalLogs: this.globalLogs.slice(0, 80),
      radiusAlerts,
      externalPings: this.externalPings,
      ...(alertSettings ? { alertSettings } : {}),
      globalMetrics: [
        { label: 'MikroTik Online', nilai: `${onlineCount}/${this.routers.length}` },
        { label: 'Mode Live', nilai: `${liveCount}/${this.routers.length}` },
        { label: 'Hotspot Aktif', nilai: `${totalHotspotActive} user` },
        { label: 'RADIUS Alert', nilai: totalRadiusTimeouts > 0 ? `${totalRadiusTimeouts} timeout` : 'Aman' },
        { label: 'Approval', nilai: `${pendingTotal} antre` },
      ],
    };
  }

  private recordTelemetry(tel: RouterTelemetry): void {
    this.telemetryMap.set(tel.routerId, tel);
    const prev = this.historyMap.get(tel.routerId) ?? [];
    const point: TelemetryPoint = {
      timestamp: tel.timestamp,
      cpuLoadPercent: tel.cpuLoadPercent,
      memoryUsedPercent: tel.memoryUsedPercent,
      reachable: tel.reachable,
    };
    const next = [...prev, point].slice(-MAX_HISTORY_POINTS);
    this.historyMap.set(tel.routerId, next);
  }

  private broadcast(): void {
    this.onBroadcast(this.buildSnapshot());
  }
}
