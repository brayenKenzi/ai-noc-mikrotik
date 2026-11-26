export type RouterRole = 'core' | 'bras' | 'branch';
export type AgentRoom = 'core' | 'distribusi' | 'security';
export type AgentDutyRole = 'backbone_master' | 'link_guard' | 'core_vlan_watchdog' | 'bras_gateway' | 'branch_dist';
export type RouterHealthStatus = 'healthy' | 'warning' | 'critical' | 'offline';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'FAILED' | 'EXPIRED';

export interface InterfacePingConfig {
  readonly interfaceName: string;
  readonly target: string;
  readonly warnMs?: number;
  readonly critMs?: number;
}

export type FiberLinkType = 'backbone' | 'vlan' | 'olt' | 'backup';

export interface TopologyLink {
  readonly id: string;
  readonly fromRouterId: string;
  readonly fromInterface: string;
  readonly toRouterId: string;
  readonly toInterface: string;
  readonly label: string;
  readonly fiberType: FiberLinkType;
  readonly color?: string;
}

export interface LiveTopologyLink extends TopologyLink {
  readonly fromRouterName: string;
  readonly toRouterName: string;
  readonly status: 'ok' | 'degraded' | 'down';
  readonly liveMbps: number;
  readonly statusReason: string;
}

export interface TopologyNodePosition {
  readonly routerId: string;
  readonly x: number;
  readonly y: number;
}

export interface AiLearnedFact {
  readonly id: string;
  readonly createdAt: string;
  readonly source: string;
  readonly topic: string;
  readonly text: string;
}

export interface AiMemorySummary {
  readonly totalConversations: number;
  readonly learnedFacts: readonly AiLearnedFact[];
}

export interface PppoeDropStatus {
  readonly routerId: string;
  readonly previousPeak: number;
  readonly currentCount: number;
  readonly droppedCount: number;
  readonly droppedPercent: number;
  readonly suspectedOltInterfaces: readonly string[];
  readonly activeIncident: boolean;
  readonly detectedAt: string;
}

export interface WatchedLinkStatus {
  readonly name: string;
  readonly running: boolean;
  readonly disabled: boolean;
  readonly rxMbps: number;
  readonly txMbps: number;
  readonly totalMbps: number;
  readonly baselineMbps: number;
  readonly dropPercent: number;
  readonly state: 'ok' | 'drop' | 'down';
}

export type PlaybookActionType =
  | 'ADD_FIREWALL_BLOCKLIST'
  | 'RESET_PPPOE_SESSION'
  | 'ENABLE_INTERFACE'
  | 'SWITCH_BACKUP_ROUTE'
  | 'DIAGNOSTIC_ONLY';

export interface RouterDevice {
  readonly id: string;
  readonly name: string;
  readonly deviceModel?: string;
  readonly host: string;
  readonly port: number;
  readonly useTls: boolean;
  readonly routerOsVersion: 'v6' | 'v7';
  readonly role: RouterRole;
  readonly agentName: string;
  readonly dutyRole?: AgentDutyRole;
  readonly dutyLabel?: string;
  readonly watchedInterfaces?: readonly string[];
  readonly trafficDropThresholdPct?: number;
  readonly minTrafficMbps?: number;
  readonly interfacePing?: InterfacePingConfig | null;
  readonly customPrompt?: string;
  readonly agentColor: string;
  readonly room: AgentRoom;
  readonly deskX: number;
  readonly deskZ: number;
  readonly readUsername: string;
  readonly readSecretEnv: string;
  readonly readPasswordEnc?: string;
  readonly execUsername: string;
  readonly execSecretEnv: string;
  readonly execPasswordEnc?: string;
  readonly simulated?: boolean;
}

export interface RouterPublicConfig {
  readonly id: string;
  readonly name: string;
  readonly agentName: string;
  readonly dutyRole: AgentDutyRole;
  readonly dutyLabel: string;
  readonly watchedInterfaces: readonly string[];
  readonly trafficDropThresholdPct: number;
  readonly minTrafficMbps: number;
  readonly interfacePing: InterfacePingConfig | null;
  readonly customPrompt: string;
  readonly deviceModel: string;
  readonly host: string;
  readonly port: number;
  readonly useTls: boolean;
  readonly routerOsVersion: 'v6' | 'v7';
  readonly role: RouterRole;
  readonly readUsername: string;
  readonly hasCustomReadPassword: boolean;
  readonly writeExecutionReady?: boolean;
  readonly simulated: boolean;
}

export interface RouterUpdatePatch {
  readonly name?: string;
  readonly agentName?: string;
  readonly dutyRole?: AgentDutyRole;
  readonly dutyLabel?: string;
  readonly watchedInterfaces?: readonly string[];
  readonly trafficDropThresholdPct?: number;
  readonly minTrafficMbps?: number;
  readonly interfacePing?: InterfacePingConfig | null;
  readonly customPrompt?: string;
  readonly host?: string;
  readonly port?: number;
  readonly useTls?: boolean;
  readonly routerOsVersion?: 'v6' | 'v7';
  readonly readUsername?: string;
  readonly readPassword?: string;
  readonly clearReadPassword?: boolean;
  readonly simulated?: boolean;
}

export interface NewRouterInput {
  readonly name: string;
  readonly deviceModel?: string;
  readonly host: string;
  readonly port: number;
  readonly useTls: boolean;
  readonly routerOsVersion: 'v6' | 'v7';
  readonly role: RouterRole;
  readonly room: AgentRoom;
  readonly agentName?: string;
  readonly readUsername: string;
  readonly readPassword?: string;
  readonly simulated: boolean;
}

export interface InterfaceMetric {
  readonly name: string;
  readonly defaultName?: string;
  readonly running: boolean;
  readonly disabled: boolean;
  readonly rxMbps: number;
  readonly txMbps: number;
}

export interface TelemetryPoint {
  readonly timestamp: string;
  readonly cpuLoadPercent: number;
  readonly memoryUsedPercent: number;
  readonly reachable: boolean;
}

export interface PingMetric {
  readonly target: string;
  readonly label: string;
  readonly minMs: number | null;
  readonly avgMs: number | null;
  readonly maxMs: number | null;
  readonly packetLossPercent: number;
  readonly status: 'ok' | 'high' | 'critical' | 'down';
  readonly updatedAt: string;
}

export interface SfpOpticalMetric {
  readonly name: string;
  readonly modulePresent: boolean;
  readonly linkOk: boolean;
  readonly rxPowerDbm: number | null;
  readonly txPowerDbm: number | null;
  readonly temperatureC: number | null;
  readonly wavelengthNm: number | null;
  readonly vendor: string;
  readonly health: 'ok' | 'warning' | 'critical' | 'empty';
}

export interface CustomerSessionMatch {
  readonly type: 'pppoe' | 'hotspot';
  readonly routerId: string;
  readonly routerName: string;
  readonly username: string;
  readonly address: string;
  readonly macOrCallerId: string;
  readonly uptime: string;
  readonly serviceOrServer: string;
  readonly rxMbps: number | null;
  readonly txMbps: number | null;
  readonly totalRxMb: number | null;
  readonly totalTxMb: number | null;
  readonly viaRadius: boolean;
}

export interface CustomerLookupResult {
  readonly query: string;
  readonly searchedRouters: number;
  readonly matches: readonly CustomerSessionMatch[];
  readonly relatedLogs: readonly SyslogEntry[];
  readonly checkedAt: string;
}

export interface RscBackupEntry {
  readonly routerId: string;
  readonly routerName: string;
  readonly fileName: string;
  readonly folderPath: string;
  readonly lastBackupAt: string;
  readonly sizeBytes: number;
  readonly lineCount: number;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly diffPreview: readonly string[];
  readonly status: 'ok' | 'unchanged' | 'error';
  readonly error?: string;
}

export interface RscBackupSummary {
  readonly folderName: string;
  readonly lastRunAt: string | null;
  readonly lastGitSyncAt: string | null;
  readonly lastGitSyncStatus: string;
  readonly entries: readonly RscBackupEntry[];
}

export interface AlertSettings {
  readonly waEnabled: boolean;
  readonly waTarget: string;
  readonly dailyReportEnabled: boolean;
  readonly dailyReportHour: number;
  readonly lastDailyReportDate?: string;
  readonly pingWarnMs: number;
  readonly pingCritMs: number;
  readonly extPingCritMs: number;
  readonly pingLossCritPct: number;
  readonly pingConfirmCount: number;
  readonly pppoeMassDropCount?: number;
  readonly sfpRxCritDbm?: number;
  readonly waChatEnabled?: boolean;
  readonly waAllowedSenders?: readonly string[];
  readonly alertCooldownSec: number;
}

export interface RouterTelemetry {
  readonly routerId: string;
  readonly timestamp: string;
  readonly reachable: boolean;
  readonly uptime: string;
  readonly version: string;
  readonly boardName: string;
  readonly cpuLoadPercent: number;
  readonly memoryUsedPercent: number;
  readonly temperatureC: number | null;
  readonly voltageV: number | null;
  readonly activePppoeCount: number;
  readonly activeHotspotCount: number;
  readonly hotspotHostCount: number;
  readonly dhcpLeaseCount: number;
  readonly bgpPeersEstablished: number;
  readonly bgpPeersTotal: number;
  readonly interfaces: readonly InterfaceMetric[];
  readonly sfpOptics?: readonly SfpOpticalMetric[];
  readonly ping?: PingMetric | null;
  readonly interfacePingResult?: PingMetric | null;
  readonly watchedLinks?: readonly WatchedLinkStatus[];
  readonly pppoeDrop?: PppoeDropStatus | null;
  readonly status: RouterHealthStatus;
  readonly lastError?: string;
}

export interface SyslogEntry {
  readonly id: string;
  readonly routerId: string;
  readonly sourceIp: string;
  readonly timestamp: string;
  readonly topics: readonly string[];
  readonly severity: 'info' | 'warning' | 'error' | 'critical';
  readonly message: string;
}

export interface ActionProposalPayload {
  readonly actionType: PlaybookActionType;
  readonly parameters: Readonly<Record<string, string>>;
  readonly previewCommand: string;
  readonly rollbackCommand: string;
  readonly riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface ApprovalTicket {
  readonly id: string;
  readonly routerId: string;
  readonly routerName: string;
  readonly agentName: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: ApprovalStatus;
  readonly incidentSummary: string;
  readonly rootCauseAnalysis: string;
  readonly proposal: ActionProposalPayload;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly executionResult?: string;
}

export interface RadiusTimeoutAlert {
  readonly routerId: string;
  readonly routerName: string;
  readonly agentName: string;
  readonly username: string;
  readonly message: string;
  readonly timestamp: string;
  readonly count: number;
}

export interface AiChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'antigravity';
  readonly source: string;
  readonly timestamp: string;
  readonly text: string;
}

export interface AiBridgeState {
  readonly linked: boolean;
  readonly agentLabel: string;
  readonly lastHeartbeatAt: string;
  readonly lastBriefing?: string;
  readonly messages: readonly AiChatMessage[];
}

export interface SpvReportEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly routerId: string;
  readonly routerName: string;
  readonly agentName: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly category: 'ping' | 'radius' | 'offline' | 'resource' | 'hotspot' | 'link' | 'pppoe_mass' | 'sfp' | 'recovery';
  readonly message: string;
  readonly sentToWa: boolean;
}

export interface SpvNocState {
  readonly id: 'spv-noc';
  readonly name: string;
  readonly role: string;
  readonly linked: boolean;
  readonly modelLabel: string;
  readonly lastHeartbeatAt: string;
  readonly totalRouters: number;
  readonly liveRouters: number;
  readonly activeAlerts: number;
  readonly reports: readonly SpvReportEntry[];
  readonly messages: readonly AiChatMessage[];
}

export interface OfficeAgentView {
  readonly key: string;
  readonly routerId: string;
  readonly nama: string;
  readonly tugas: string;
  readonly ruang: AgentRoom;
  readonly warna: string;
  readonly x: number;
  readonly z: number;
  readonly activity: 'kerja' | 'laporan' | 'belajar' | 'siaga';
  readonly activityLabel: string;
  readonly ringkasan: string;
  readonly menunggu: readonly string[];
  readonly mendesak: readonly string[];
  readonly angka: readonly { readonly label: string; readonly nilai: string }[];
  readonly routerConfig: RouterPublicConfig;
  readonly telemetry: RouterTelemetry | null;
  readonly telemetryHistory: readonly TelemetryPoint[];
  readonly recentLogs: readonly SyslogEntry[];
  readonly pendingApprovals: readonly ApprovalTicket[];
  readonly radiusTimeoutCount: number;
  readonly hotspotFailedLoginCount: number;
  readonly hotspotFailedUsers: readonly string[];
  readonly aiBridge?: AiBridgeState;
}

export interface NocSnapshot {
  readonly updatedAt: string;
  readonly spvNoc: SpvNocState;
  readonly agents: readonly OfficeAgentView[];
  readonly topologyLinks: readonly LiveTopologyLink[];
  readonly topologyPositions: readonly TopologyNodePosition[];
  readonly aiMemory: AiMemorySummary;
  readonly rscBackups?: RscBackupSummary;
  readonly approvals: readonly ApprovalTicket[];
  readonly globalLogs: readonly SyslogEntry[];
  readonly radiusAlerts: readonly RadiusTimeoutAlert[];
  readonly externalPings: readonly PingMetric[];
  readonly alertSettings?: AlertSettings & { readonly waTokenConfigured: boolean };
  readonly globalMetrics: readonly { readonly label: string; readonly nilai: string }[];
}
