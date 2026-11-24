export type RouterRole = 'core' | 'bras' | 'branch';
export type AgentRoom = 'core' | 'distribusi' | 'security';
export type RouterHealthStatus = 'healthy' | 'warning' | 'critical' | 'offline';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'FAILED' | 'EXPIRED';

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
  readonly deviceModel: string;
  readonly host: string;
  readonly port: number;
  readonly useTls: boolean;
  readonly routerOsVersion: 'v6' | 'v7';
  readonly role: RouterRole;
  readonly readUsername: string;
  readonly hasCustomReadPassword: boolean;
  readonly simulated: boolean;
}

export interface RouterUpdatePatch {
  readonly name?: string;
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
  readonly bgpPeersEstablished: number;
  readonly bgpPeersTotal: number;
  readonly interfaces: readonly InterfaceMetric[];
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
  readonly aiBridge?: AiBridgeState;
}

export interface NocSnapshot {
  readonly updatedAt: string;
  readonly agents: readonly OfficeAgentView[];
  readonly approvals: readonly ApprovalTicket[];
  readonly globalLogs: readonly SyslogEntry[];
  readonly radiusAlerts: readonly RadiusTimeoutAlert[];
  readonly globalMetrics: readonly { readonly label: string; readonly nilai: string }[];
}
