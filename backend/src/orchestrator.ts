import crypto from 'node:crypto';
import type {
  ApprovalTicket,
  NewRouterInput,
  NocSnapshot,
  OfficeAgentView,
  RadiusTimeoutAlert,
  RouterDevice,
  RouterPublicConfig,
  RouterTelemetry,
  RouterUpdatePatch,
  SyslogEntry,
  TelemetryPoint,
} from './types.js';
import { allocateDeskSlot } from './inventory.js';
import { pollRouterTelemetry, pollRouterWithLogs } from './poller.js';
import { isAnomalySyslog, isRadiusTimeoutMessage, parseRadiusTimeoutUser } from './syslogReceiver.js';
import { analyzeRouterIncident } from './aiAgent.js';
import { ApprovalGateStore } from './approvalStore.js';
import { executeApprovedProposal } from './playbooks.js';
import { TelegramNocBot } from './telegramBot.js';
import type { SecretVault } from './secretVault.js';
import { AntigravityBridgeStore, generateLiveAgentAnswer } from './antigravityBridge.js';

const MAX_HISTORY_POINTS = 30;
const MAX_GLOBAL_LOGS = 100;

export function toPublicRouterConfig(router: RouterDevice): RouterPublicConfig {
  return {
    id: router.id,
    name: router.name,
    deviceModel: router.deviceModel ?? (router.routerOsVersion === 'v7' ? 'MikroTik ROS v7' : 'MikroTik ROS v6'),
    host: router.host,
    port: router.port,
    useTls: router.useTls,
    routerOsVersion: router.routerOsVersion,
    role: router.role,
    readUsername: router.readUsername,
    hasCustomReadPassword: Boolean(router.readPasswordEnc),
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
  private readonly historyMap = new Map<string, readonly TelemetryPoint[]>();
  private readonly logsMap = new Map<string, readonly SyslogEntry[]>();
  private readonly seenLogIds = new Set<string>();
  private globalLogs: readonly SyslogEntry[] = [];
  private readonly cooldownMap = new Map<string, number>();
  private readonly approvalStore: ApprovalGateStore;
  private readonly telegramBot: TelegramNocBot;
  private readonly nocServerIp: string;
  private readonly onBroadcast: (snapshot: NocSnapshot) => void;
  private readonly onPersistRouters?: (routers: readonly RouterDevice[]) => Promise<void>;
  private readonly secretVault?: SecretVault;
  private readonly aiBridge?: AntigravityBridgeStore;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;

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
  }) {
    this.routers = options.routers;
    this.approvalStore = options.approvalStore;
    this.nocServerIp = options.nocServerIp;
    this.onBroadcast = options.onBroadcast;
    this.onPersistRouters = options.onPersistRouters;
    this.secretVault = options.secretVault;
    this.aiBridge = options.aiBridge;

    this.telegramBot = new TelegramNocBot(options.telegramToken, options.telegramChatId, {
      onApprove: (ticketId, actor) => this.approveAndExecute(ticketId, actor),
      onReject: (ticketId, actor) => this.rejectProposal(ticketId, actor),
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
    const telemetry = this.telemetryMap.get(routerId) ?? null;
    const history = this.historyMap.get(routerId) ?? [];
    const recentLogs = this.logsMap.get(routerId) ?? [];

    const result = await generateLiveAgentAnswer({
      router,
      telemetry,
      history,
      recentLogs,
      question,
    });
    if (this.aiBridge) {
      await this.aiBridge.appendConversation(routerId, question, result.reply, result.source);
    }
    this.broadcast();
    return result;
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
    this.telemetryMap.delete(routerId);
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

  async start(pollIntervalMs = 15000): Promise<void> {
    await this.pollAllRouters();
    this.telegramBot.start();
    this.pollTimer = setInterval(() => {
      void this.pollAllRouters();
    }, pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.telegramBot.stop();
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
        if (tel.status === 'critical' || tel.status === 'offline') {
          const router = this.routers.find((r) => r.id === tel.routerId);
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

    const hasRadiusOrAnomaly = fresh.some((e) => isRadiusTimeoutMessage(e.message) || isAnomalySyslog(e));
    if (hasRadiusOrAnomaly) {
      const router = this.routers.find((r) => r.id === routerId);
      if (router) {
        await this.triggerAgentInvestigation(router, fresh.some((e) => isRadiusTimeoutMessage(e.message)));
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
      const tel = this.telemetryMap.get(r.id) ?? null;
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

      const menunggu = pending.map((p) => `[#${p.id}] ${p.incidentSummary} → Setujui ${p.proposal.actionType}?`);
      const mendesak: string[] = [];

      if (radiusLogs[0]) {
        const failedUser = parseRadiusTimeoutUser(radiusLogs[0].message) ?? 'unknown';
        mendesak.push(`🚨 RADIUS TIMEOUT (${radiusTimeoutCount}x): user "${failedUser}" gagal autentikasi!`);
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
      let activity: OfficeAgentView['activity'] = 'kerja';
      let activityLabel = `${modeTag} · ${r.routerOsVersion}`;
      if (radiusTimeoutCount > 0) {
        activity = 'laporan';
        activityLabel = `🚨 RADIUS (${radiusTimeoutCount}x)`;
      } else if (pending.length > 0) {
        activity = 'laporan';
        activityLabel = `🔒 ${pending.length} approval`;
      } else if (tel?.status === 'offline') {
        activity = 'kerja';
        activityLabel = `⚠ OFFLINE`;
      } else if (tel) {
        activity = 'kerja';
        activityLabel = `${bridgeState?.linked ? '⚡AI · ' : `${modeTag} · `}${tel.cpuLoadPercent}%`;
      }

      const ringkasan = radiusLogs[0]
        ? `🚨 RADIUS TIMEOUT: user "${parseRadiusTimeoutUser(radiusLogs[0].message) ?? 'unknown'}" gagal login (${radiusTimeoutCount}x)`
        : pending[0]
          ? `Menunggu Approval: ${pending[0].incidentSummary}`
          : tel
            ? `[${modeTag}] ${r.name} (${tel.boardName}) · CPU ${tel.cpuLoadPercent}% · RAM ${tel.memoryUsedPercent}% · Uptime ${tel.uptime}`
            : `Menghubungi ${r.name} (${r.host})…`;

      const angka = [
        { label: `CPU ${r.name}`, nilai: tel ? `${tel.cpuLoadPercent}%` : '-' },
        ...(tel && tel.activePppoeCount > 0 ? [{ label: `PPPoE ${r.name}`, nilai: `${tel.activePppoeCount} aktif` }] : []),
        ...(r.role === 'core' && tel && tel.bgpPeersTotal > 0
          ? [{ label: `BGP ${r.name}`, nilai: `${tel.bgpPeersEstablished}/${tel.bgpPeersTotal} up` }]
          : []),
      ];

      return {
        key: r.id,
        routerId: r.id,
        nama: r.agentName,
        tugas: `${r.name} (${r.host})`,
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
        ...(bridgeState ? { aiBridge: bridgeState } : {}),
      };
    });

    const onlineCount = agents.filter((a) => a.telemetry?.reachable).length;
    const liveCount = this.routers.filter((r) => !r.simulated).length;
    const totalRadiusTimeouts = radiusAlerts.reduce((acc, a) => acc + a.count, 0);
    const pendingTotal = allApprovals.filter((a) => a.status === 'PENDING').length;

    return {
      updatedAt: new Date().toISOString(),
      agents,
      approvals: allApprovals.slice(0, 60),
      globalLogs: this.globalLogs.slice(0, 80),
      radiusAlerts,
      globalMetrics: [
        { label: 'MikroTik Online', nilai: `${onlineCount}/${this.routers.length}` },
        { label: 'Mode Live', nilai: `${liveCount}/${this.routers.length}` },
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
