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
import type { NewTopologyLinkInput, TopologyStore } from './topologyStore.js';
import type { AiMemoryStore } from './aiMemoryStore.js';
import type { AiLearnedFact, TopologyLink, TopologyNodePosition } from './types.js';
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
  private readonly externalPingTargets: readonly string[];
  private readonly nocServerIp: string;
  private readonly onBroadcast: (snapshot: NocSnapshot) => void;
  private readonly onPersistRouters?: (routers: readonly RouterDevice[]) => Promise<void>;
  private readonly secretVault?: SecretVault;
  private readonly aiBridge?: AntigravityBridgeStore;
  private pollTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private dailyReportTimer: NodeJS.Timeout | null = null;
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

  async askSpvNoc(
    question: string,
    focusRouterId?: string,
    userSource = 'Boss / Admin',
  ): Promise<{ readonly reply: string; readonly source: string }> {
    const snapshot = this.buildSnapshot();
    const pending = this.approvalStore.getAll().filter((a) => a.status === 'PENDING');
    const memoryContext = this.aiMemoryStore?.retrieveRelevantContext(question);
    const result = await generateSpvFleetAnswer({
      agents: snapshot.agents,
      externalPings: this.externalPings,
      reports: this.spvReports,
      pendingApprovals: pending,
      topologyLinks: snapshot.topologyLinks,
      memoryContext,
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
    const summaryText = buildSpvWhatsappSummary(snapshot.agents, this.externalPings, this.spvReports);
    const target = (targetOverride ?? this.fonnteNotifier.getSettings().waTarget).trim();
    const res = await this.fonnteNotifier.sendRaw(target, summaryText);
    if (res.ok) {
      this.recordSpvReport({
        routerId: 'spv-noc',
        routerName: 'SEMUA ROUTER',
        agentName: 'SPV NOC',
        severity: 'info',
        category: 'recovery',
        message: 'Rekap ringkas seluruh jaringan dikirim ke WhatsApp Boss via Fonnte.',
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
    return undefined;
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

    // Check every 60s for 1x Daily Scheduled WhatsApp Report (never duplicates on same date)
    this.dailyReportTimer = setInterval(() => {
      void this.checkAndSendDailyReport();
    }, 60_000);
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
    const reportText = buildSpvWhatsappSummary(snapshot.agents, this.externalPings, this.spvReports, true);
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
        message: 'Laporan harian 1x/hari terkirim ke WhatsApp & Telegram.',
        sentToWa: true,
      });
      this.broadcast();
      return true;
    }
    return false;
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

      const badge =
        metric.status === 'down'
          ? '🚨 DARURAT SPV NOC — PING RTO / PUTUS'
          : '🚨 KRITIS SPV NOC — PING SANGAT TINGGI / LOSS';
      const rttLine =
        metric.avgMs !== null
          ? `LATENSI: avg ${metric.avgMs} ms (min ${metric.minMs} / max ${metric.maxMs} ms)`
          : `LATENSI: RTO / TIDAK MERESPONS`;
      const msg = [
        badge,
        `DILAPORKAN OLEH: ${agentName}`,
        `TARGET: ${routerName} (${metric.target})`,
        rttLine,
        `PACKET LOSS: ${metric.packetLossPercent}%`,
        `KONFIRMASI: ${streak}x berturut-turut (ambang kritis ≥ ${thresholds.critMs} ms / loss ≥ ${thresholds.lossCritPct}%)`,
        `Waktu: ${new Date().toLocaleString('id-ID')}`,
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

      const recoveryMsg = [
        `✅ PULIH SPV NOC — PING KEMBALI NORMAL`,
        `TARGET: ${routerName} (${metric.target})`,
        `LATENSI SEKARANG: ${metric.avgMs ?? 0} ms · LOSS ${metric.packetLossPercent}%`,
        `Waktu: ${new Date().toLocaleString('id-ID')}`,
      ].join('\n');
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
          const confirmNeeded = Math.max(2, this.fonnteNotifier.getSettings().pingConfirmCount ?? 3);
          if (tel.status === 'offline') {
            this.resourceCritStreakMap.set(router.id, 0);
            const offStreak = (this.offlineStreakMap.get(router.id) ?? 0) + 1;
            this.offlineStreakMap.set(router.id, offStreak);
            if (offStreak >= confirmNeeded) {
              const offlineMsg = [
                `🚨 DARURAT SPV NOC — ROUTER OFFLINE`,
                `DILAPORKAN OLEH: ${router.agentName}`,
                `PERANGKAT: ${router.name} (${router.host}:${router.port})`,
                `DETAIL: ${tel.lastError ?? 'Router tidak terjangkau via API'} (${offStreak}x cek berturut-turut)`,
                `Waktu: ${new Date().toLocaleString('id-ID')}`,
              ].join('\n');
              const sent = await this.fonnteNotifier.sendAlertWithCooldown(`offline:${router.id}`, offlineMsg);
              if (sent) {
                void this.telegramBot.sendPlainAlert(offlineMsg);
                this.recordSpvReport({
                  routerId: router.id,
                  routerName: router.name,
                  agentName: router.agentName,
                  severity: 'critical',
                  category: 'offline',
                  message: `Router OFFLINE terkonfirmasi (${tel.lastError ?? 'API unreachable'})`,
                  sentToWa: true,
                });
              }
            }
          } else {
            this.offlineStreakMap.set(router.id, 0);
            const recMsg = `✅ PULIH SPV NOC — ROUTER ONLINE KEMBALI\nPERANGKAT: ${router.name} (${router.host}) kembali normal · CPU ${tel.cpuLoadPercent}% · Uptime ${tel.uptime}`;
            const sentRec = await this.fonnteNotifier.sendRecoveryIfActive(`offline:${router.id}`, recMsg);
            if (sentRec) {
              void this.telegramBot.sendPlainAlert(recMsg);
              this.recordSpvReport({
                routerId: router.id,
                routerName: router.name,
                agentName: router.agentName,
                severity: 'info',
                category: 'recovery',
                message: `Router kembali ONLINE (CPU ${tel.cpuLoadPercent}%, uptime ${tel.uptime})`,
                sentToWa: true,
              });
            }

            // Only alert WA on SUSTAINED extreme hardware overload (not 1-tick CPU spikes!)
            const extremeHw =
              tel.cpuLoadPercent >= 95 ||
              tel.memoryUsedPercent >= 95 ||
              (tel.temperatureC !== null && tel.temperatureC >= 78);
            if (extremeHw) {
              const hwStreak = (this.resourceCritStreakMap.get(router.id) ?? 0) + 1;
              this.resourceCritStreakMap.set(router.id, hwStreak);
              const requiredHwStreak = tel.temperatureC !== null && tel.temperatureC >= 78 ? 3 : 5;
              if (hwStreak >= requiredHwStreak) {
                const critMsg = [
                  `🔥 KRITIS SPV NOC — OVERLOAD HARDWARE BERKELANJUTAN`,
                  `DILAPORKAN OLEH: ${router.agentName}`,
                  `PERANGKAT: ${router.name} (${tel.boardName})`,
                  `CPU: ${tel.cpuLoadPercent}% · RAM: ${tel.memoryUsedPercent}%${tel.temperatureC !== null ? ` · SUHU: ${tel.temperatureC}°C` : ''}`,
                  `KONFIRMASI: Bertahan tinggi ${hwStreak}x pengecekan berturut-turut`,
                  `Waktu: ${new Date().toLocaleString('id-ID')}`,
                ].join('\n');
                const sentCrit = await this.fonnteNotifier.sendAlertWithCooldown(`critical:${router.id}`, critMsg);
                if (sentCrit) {
                  void this.telegramBot.sendPlainAlert(critMsg);
                  this.recordSpvReport({
                    routerId: router.id,
                    routerName: router.name,
                    agentName: router.agentName,
                    severity: 'critical',
                    category: 'resource',
                    message: `Overload berkelanjutan: CPU ${tel.cpuLoadPercent}% · RAM ${tel.memoryUsedPercent}%${tel.temperatureC !== null ? ` · Suhu ${tel.temperatureC}°C` : ''}`,
                    sentToWa: true,
                  });
                }
              }
            } else {
              this.resourceCritStreakMap.set(router.id, 0);
            }

            // Evaluate Role-Specific Watched Links & Traffic Drop Watchdog (CRS Backbone & CORE MONGKONAI vlan2000-CMK!)
            const { statuses: watchedStatuses, events: linkEvents } = this.linkWatchdog.evaluateRouterInterfaces(
              router,
              tel.interfaces,
              confirmNeeded,
            );
            const duty = resolveRouterDutyProfile(router);
            for (const ev of linkEvents) {
              const impactNote =
                duty.dutyRole === 'core_vlan_watchdog' && ev.interfaceName.toLowerCase().includes('vlan2000')
                  ? 'DAMPAK: Jalur utama penyuplai CCR Mongkonai terganggu!'
                  : duty.dutyRole === 'backbone_master'
                    ? 'DAMPAK: Jalur suplai Master Backbone CRS-BB01 ke distribusi terdampak!'
                    : '';

              if (ev.kind === 'down' || ev.kind === 'drop') {
                const badge =
                  ev.kind === 'down'
                    ? `🚨 KRITIS SPV NOC — LINK ${ev.interfaceName} DOWN`
                    : `⚠️ KRITIS SPV NOC — TRAFIK ${ev.interfaceName} DROP DRASTIS`;
                const linkMsg = [
                  badge,
                  `DILAPORKAN OLEH: ${router.agentName} (${duty.dutyLabel})`,
                  `ROUTER: ${router.name} (${router.host})`,
                  `DETAIL: ${ev.message}`,
                  impactNote,
                  `Waktu: ${new Date().toLocaleString('id-ID')}`,
                ]
                  .filter(Boolean)
                  .join('\n');
                const sentLink = await this.fonnteNotifier.sendAlertWithCooldown(ev.key, linkMsg);
                if (sentLink) {
                  void this.telegramBot.sendPlainAlert(linkMsg);
                  this.recordSpvReport({
                    routerId: router.id,
                    routerName: router.name,
                    agentName: router.agentName,
                    severity: 'critical',
                    category: 'link',
                    message: `${ev.message}${impactNote ? ` · ${impactNote}` : ''}`,
                    sentToWa: true,
                  });
                }
              } else if (ev.kind === 'recovered') {
                const recLinkMsg = [
                  `✅ PULIH SPV NOC — LINK ${ev.interfaceName} NORMAL`,
                  `ROUTER: ${router.name} (${router.host})`,
                  `DETAIL: ${ev.message}`,
                  `Waktu: ${new Date().toLocaleString('id-ID')}`,
                ].join('\n');
                const sentRecLink = await this.fonnteNotifier.sendRecoveryIfActive(ev.key, recLinkMsg);
                if (sentRecLink) {
                  void this.telegramBot.sendPlainAlert(recLinkMsg);
                  this.recordSpvReport({
                    routerId: router.id,
                    routerName: router.name,
                    agentName: router.agentName,
                    severity: 'info',
                    category: 'recovery',
                    message: ev.message,
                    sentToWa: true,
                  });
                }
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
              const massMsg = [
                `🚨 DARURAT SPV NOC — MASS-DISCONNECT PPPOE (OLT / FO PUTUS!)`,
                `DILAPORKAN OLEH: ${router.agentName}`,
                `ROUTER: ${router.name} (${router.host})`,
                `DETAIL: ${massEvent.message}`,
                `SARAN SEGERA: Cek power OLT, jalur fiber PON/ODP, dan uplink menuju ${router.name}.`,
                `Waktu: ${new Date().toLocaleString('id-ID')}`,
              ].join('\n');
              const sentMass = await this.fonnteNotifier.sendAlertWithCooldown(massEvent.key, massMsg);
              if (sentMass) {
                void this.telegramBot.sendPlainAlert(massMsg);
                this.recordSpvReport({
                  routerId: router.id,
                  routerName: router.name,
                  agentName: router.agentName,
                  severity: 'critical',
                  category: 'pppoe_mass',
                  message: massEvent.message,
                  sentToWa: true,
                });
              }
            } else if (massEvent?.kind === 'recovered') {
              const recMassMsg = [
                `✅ PULIH SPV NOC — PELANGGAN PPPOE KEMBALI ONLINE`,
                `ROUTER: ${router.name} (${router.host})`,
                `DETAIL: ${massEvent.message}`,
                `Waktu: ${new Date().toLocaleString('id-ID')}`,
              ].join('\n');
              const sentRecMass = await this.fonnteNotifier.sendRecoveryIfActive(massEvent.key, recMassMsg);
              if (sentRecMass) {
                void this.telegramBot.sendPlainAlert(recMassMsg);
                this.recordSpvReport({
                  routerId: router.id,
                  routerName: router.name,
                  agentName: router.agentName,
                  severity: 'info',
                  category: 'recovery',
                  message: massEvent.message,
                  sentToWa: true,
                });
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

          if (nextHits.length >= 3) {
            const failedUser = parseRadiusTimeoutUser(freshRadius[0].message) ?? 'unknown';
            const radiusMsg = [
              `🚨 KRITIS SPV NOC — GANGGUAN RADIUS TIMEOUT`,
              `DILAPORKAN OLEH: ${router.agentName}`,
              `ROUTER: ${router.name} (${router.host})`,
              `KEJADIAN: ${nextHits.length}x timeout dalam 2 menit terakhir (user terbaru: ${failedUser})`,
              `LOG: ${freshRadius[0].message}`,
              `Waktu: ${new Date().toLocaleString('id-ID')}`,
            ].join('\n');
            const sent = await this.fonnteNotifier.sendAlertWithCooldown(`radius:${router.id}`, radiusMsg);
            if (sent) {
              void this.telegramBot.sendPlainAlert(radiusMsg);
              this.recordSpvReport({
                routerId: router.id,
                routerName: router.name,
                agentName: router.agentName,
                severity: 'critical',
                category: 'radius',
                message: `RADIUS Gangguan: ${nextHits.length}x timeout dalam 2 menit (user "${failedUser}")`,
                sentToWa: true,
              });
            }
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
      const tel: RouterTelemetry | null = baseTel
        ? { ...baseTel, ping, interfacePingResult, watchedLinks, pppoeDrop }
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
