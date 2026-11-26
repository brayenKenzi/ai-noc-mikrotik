import { useCallback, useEffect, useState } from 'react';
import type { RoomKey } from './config';

export interface LiveApprovalTicket {
  id: string;
  routerId: string;
  routerName: string;
  agentName: string;
  createdAt: string;
  expiresAt: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'FAILED' | 'EXPIRED';
  incidentSummary: string;
  rootCauseAnalysis: string;
  proposal: {
    actionType: string;
    parameters: Record<string, string>;
    previewCommand: string;
    rollbackCommand: string;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  };
  decidedBy?: string;
  decidedAt?: string;
  executionResult?: string;
}

export type LiveAgentDutyRole =
  | 'backbone_master'
  | 'link_guard'
  | 'core_vlan_watchdog'
  | 'bras_gateway'
  | 'branch_dist';

export interface LiveInterfacePingConfig {
  interfaceName: string;
  target: string;
  warnMs?: number;
  critMs?: number;
}

export type LiveFiberLinkType = 'backbone' | 'vlan' | 'olt' | 'backup';

export interface LiveTopologyLink {
  id: string;
  fromRouterId: string;
  fromInterface: string;
  toRouterId: string;
  toInterface: string;
  label: string;
  fiberType: LiveFiberLinkType;
  color?: string;
  fromRouterName: string;
  toRouterName: string;
  status: 'ok' | 'degraded' | 'down';
  liveMbps: number;
  statusReason: string;
}

export interface LiveTopologyNodePosition {
  routerId: string;
  x: number;
  y: number;
}

export interface LiveAiLearnedFact {
  id: string;
  createdAt: string;
  source: string;
  topic: string;
  text: string;
}

export interface LiveAiMemorySummary {
  totalConversations: number;
  learnedFacts: LiveAiLearnedFact[];
}

export interface LivePppoeDropStatus {
  routerId: string;
  previousPeak: number;
  currentCount: number;
  droppedCount: number;
  droppedPercent: number;
  suspectedOltInterfaces: string[];
  activeIncident: boolean;
  detectedAt: string;
}

export interface LiveWatchedLinkStatus {
  name: string;
  running: boolean;
  disabled: boolean;
  rxMbps: number;
  txMbps: number;
  totalMbps: number;
  baselineMbps: number;
  dropPercent: number;
  state: 'ok' | 'drop' | 'down';
}

export interface LiveRouterConfig {
  id: string;
  name: string;
  agentName?: string;
  dutyRole?: LiveAgentDutyRole;
  dutyLabel?: string;
  watchedInterfaces?: string[];
  trafficDropThresholdPct?: number;
  minTrafficMbps?: number;
  interfacePing?: LiveInterfacePingConfig | null;
  customPrompt?: string;
  deviceModel: string;
  host: string;
  port: number;
  useTls: boolean;
  routerOsVersion: 'v6' | 'v7';
  role: 'core' | 'bras' | 'branch';
  readUsername: string;
  hasCustomReadPassword?: boolean;
  writeExecutionReady?: boolean;
  simulated: boolean;
}

export interface LiveTelemetryPoint {
  timestamp: string;
  cpuLoadPercent: number;
  memoryUsedPercent: number;
  reachable: boolean;
}

export interface LivePingMetric {
  target: string;
  label: string;
  minMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  packetLossPercent: number;
  status: 'ok' | 'high' | 'critical' | 'down';
  updatedAt: string;
}

export interface LiveAlertSettings {
  waEnabled: boolean;
  waTarget: string;
  dailyReportEnabled?: boolean;
  dailyReportHour?: number;
  lastDailyReportDate?: string;
  pingWarnMs: number;
  pingCritMs: number;
  extPingCritMs?: number;
  pingLossCritPct: number;
  pingConfirmCount?: number;
  pppoeMassDropCount?: number;
  sfpRxCritDbm?: number;
  waChatEnabled?: boolean;
  waAllowedSenders?: string[];
  alertCooldownSec: number;
  waTokenConfigured: boolean;
}

export interface LiveSfpOpticalMetric {
  name: string;
  modulePresent: boolean;
  linkOk: boolean;
  rxPowerDbm: number | null;
  txPowerDbm: number | null;
  temperatureC: number | null;
  wavelengthNm: number | null;
  vendor: string;
  health: 'ok' | 'warning' | 'critical' | 'empty';
}

export interface LiveCustomerSessionMatch {
  type: 'pppoe' | 'hotspot';
  routerId: string;
  routerName: string;
  username: string;
  address: string;
  macOrCallerId: string;
  uptime: string;
  serviceOrServer: string;
  rxMbps: number | null;
  txMbps: number | null;
  totalRxMb: number | null;
  totalTxMb: number | null;
  viaRadius: boolean;
}

export interface LiveCustomerLookupResult {
  query: string;
  searchedRouters: number;
  matches: LiveCustomerSessionMatch[];
  relatedLogs: LiveSyslogEntry[];
  checkedAt: string;
}

export interface LiveRscBackupEntry {
  routerId: string;
  routerName: string;
  fileName: string;
  folderPath: string;
  lastBackupAt: string;
  sizeBytes: number;
  lineCount: number;
  addedLines: number;
  removedLines: number;
  diffPreview: string[];
  status: 'ok' | 'unchanged' | 'error';
  error?: string;
}

export interface LiveRscBackupSummary {
  folderName: string;
  lastRunAt: string | null;
  lastGitSyncAt: string | null;
  lastGitSyncStatus: string;
  entries: LiveRscBackupEntry[];
}

export interface LiveRouterTelemetry {
  routerId: string;
  reachable: boolean;
  uptime: string;
  version: string;
  boardName: string;
  cpuLoadPercent: number;
  memoryUsedPercent: number;
  temperatureC: number | null;
  voltageV: number | null;
  activePppoeCount: number;
  activeHotspotCount?: number;
  hotspotHostCount?: number;
  dhcpLeaseCount?: number;
  bgpPeersEstablished: number;
  bgpPeersTotal: number;
  interfaces: { name: string; running: boolean; disabled: boolean; rxMbps: number; txMbps: number }[];
  sfpOptics?: LiveSfpOpticalMetric[];
  ping?: LivePingMetric | null;
  interfacePingResult?: LivePingMetric | null;
  watchedLinks?: LiveWatchedLinkStatus[];
  pppoeDrop?: LivePppoeDropStatus | null;
  status: 'healthy' | 'warning' | 'critical' | 'offline';
  lastError?: string;
}

export interface LiveSyslogEntry {
  id: string;
  routerId: string;
  sourceIp?: string;
  timestamp: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  topics: string[];
  message: string;
}

export interface LiveRadiusAlert {
  routerId: string;
  routerName: string;
  agentName: string;
  username: string;
  message: string;
  timestamp: string;
  count: number;
}

export interface LiveAiChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'antigravity';
  source: string;
  timestamp: string;
  text: string;
}

export interface LiveAiBridgeState {
  linked: boolean;
  agentLabel: string;
  lastHeartbeatAt: string;
  lastBriefing?: string;
  messages: LiveAiChatMessage[];
}

export interface LiveSpvReportEntry {
  id: string;
  timestamp: string;
  routerId: string;
  routerName: string;
  agentName: string;
  severity: 'info' | 'warning' | 'critical';
  category: 'ping' | 'radius' | 'offline' | 'resource' | 'hotspot' | 'link' | 'pppoe_mass' | 'sfp' | 'recovery';
  message: string;
  sentToWa: boolean;
}

export interface LiveSpvNocState {
  id: 'spv-noc';
  name: string;
  role: string;
  linked: boolean;
  modelLabel: string;
  lastHeartbeatAt: string;
  totalRouters: number;
  liveRouters: number;
  activeAlerts: number;
  reports: LiveSpvReportEntry[];
  messages: LiveAiChatMessage[];
}

export interface LiveOfficeAgent {
  key: string;
  routerId: string;
  nama: string;
  tugas: string;
  ruang: RoomKey;
  warna: string;
  x: number;
  z: number;
  activity: 'kerja' | 'laporan' | 'belajar' | 'siaga';
  activityLabel: string;
  ringkasan: string;
  menunggu: string[];
  mendesak: string[];
  angka: { label: string; nilai: string }[];
  routerConfig?: LiveRouterConfig;
  telemetry: LiveRouterTelemetry | null;
  telemetryHistory?: LiveTelemetryPoint[];
  recentLogs: LiveSyslogEntry[];
  pendingApprovals: LiveApprovalTicket[];
  radiusTimeoutCount?: number;
  hotspotFailedLoginCount?: number;
  hotspotFailedUsers?: string[];
  aiBridge?: LiveAiBridgeState;
}

export interface LiveNocSnapshot {
  updatedAt: string;
  spvNoc?: LiveSpvNocState;
  agents: LiveOfficeAgent[];
  topologyLinks?: LiveTopologyLink[];
  topologyPositions?: LiveTopologyNodePosition[];
  aiMemory?: LiveAiMemorySummary;
  rscBackups?: LiveRscBackupSummary;
  approvals: LiveApprovalTicket[];
  globalLogs?: LiveSyslogEntry[];
  radiusAlerts?: LiveRadiusAlert[];
  externalPings?: LivePingMetric[];
  alertSettings?: LiveAlertSettings;
  globalMetrics: { label: string; nilai: string }[];
}

export interface RouterConfigPatch {
  name?: string;
  agentName?: string;
  dutyRole?: LiveAgentDutyRole;
  dutyLabel?: string;
  watchedInterfaces?: string[];
  trafficDropThresholdPct?: number;
  minTrafficMbps?: number;
  interfacePing?: LiveInterfacePingConfig | null;
  customPrompt?: string;
  host?: string;
  port?: number;
  useTls?: boolean;
  routerOsVersion?: 'v6' | 'v7';
  readUsername?: string;
  readPassword?: string;
  clearReadPassword?: boolean;
  simulated?: boolean;
}

export interface NewRouterPayload {
  name: string;
  deviceModel?: string;
  host: string;
  port: number;
  useTls: boolean;
  routerOsVersion: 'v6' | 'v7';
  role: 'core' | 'bras' | 'branch';
  room: RoomKey;
  agentName?: string;
  readUsername: string;
  readPassword?: string;
  simulated: boolean;
}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('noc_admin_token') ?? '';
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'x-noc-token': token } : {}),
  };
}

export function useNocLive() {
  const [authState, setAuthState] = useState<'loading' | 'authenticated' | 'unauthenticated'>('loading');
  const [adminUser, setAdminUser] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<LiveNocSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [busyTicketId, setBusyTicketId] = useState<string | null>(null);
  const [pollingNow, setPollingNow] = useState(false);

  // Check current session cookie on startup
  useEffect(() => {
    let alive = true;
    const checkSession = async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (!res.ok) {
          if (alive) setAuthState('unauthenticated');
          return;
        }
        const json = (await res.json()) as {
          success: boolean;
          data?: { authenticated: boolean; username: string | null };
        };
        if (!alive) return;
        if (json.success && json.data?.authenticated) {
          setAdminUser(json.data.username ?? 'admin');
          setAuthState('authenticated');
        } else {
          setAdminUser(null);
          setAuthState('unauthenticated');
        }
      } catch {
        if (alive) setAuthState('unauthenticated');
      }
    };
    void checkSession();
    return () => {
      alive = false;
    };
  }, []);

  // Connect live snapshot + WebSocket ONLY after admin authentication succeeds
  useEffect(() => {
    if (authState !== 'authenticated') {
      setConnected(false);
      return;
    }

    let alive = true;
    let ws: WebSocket | null = null;
    let retryTimer = 0;

    const fetchInitial = async () => {
      try {
        const res = await fetch('/api/snapshot', { credentials: 'include' });
        if (res.status === 401) {
          if (alive) setAuthState('unauthenticated');
          return;
        }
        if (!res.ok) return;
        const json = (await res.json()) as { success: boolean; data?: LiveNocSnapshot };
        if (alive && json.success && json.data) {
          setSnapshot(json.data);
        }
      } catch {
        // Ignore transient offline error
      }
    };

    const connectWs = () => {
      if (!alive) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws`);

      ws.onopen = () => {
        if (alive) setConnected(true);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { type?: string; data?: LiveNocSnapshot };
          if (msg.type === 'NOC_SNAPSHOT' && msg.data && alive) {
            setSnapshot(msg.data);
          }
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onclose = (ev) => {
        if (!alive) return;
        setConnected(false);
        if (ev.code === 4001) {
          setAuthState('unauthenticated');
          return;
        }
        retryTimer = window.setTimeout(connectWs, 3000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    void fetchInitial();
    connectWs();

    return () => {
      alive = false;
      window.clearTimeout(retryTimer);
      ws?.close();
    };
  }, [authState]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const json = (await res.json()) as {
      success: boolean;
      data?: { authenticated: boolean; username: string };
      error?: string;
    };
    if (!res.ok || !json.success) {
      throw new Error(json.error ?? 'Login gagal');
    }
    setAdminUser(json.data?.username ?? username);
    setAuthState('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } finally {
      setSnapshot(null);
      setAdminUser(null);
      setConnected(false);
      setAuthState('unauthenticated');
    }
  }, []);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string, newUsername?: string) => {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          currentPassword,
          newPassword,
          ...(newUsername?.trim() ? { newUsername: newUsername.trim() } : {}),
        }),
      });
      const json = (await res.json()) as { success: boolean; data?: { username: string }; error?: string };
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? 'Gagal mengubah password admin');
      }
      if (json.data?.username) {
        setAdminUser(json.data.username);
      }
    },
    [],
  );

  const decideApproval = useCallback(async (ticketId: string, decision: 'approve' | 'reject') => {
    setBusyTicketId(ticketId);
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(ticketId)}/${decision}`, {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders(),
        body: JSON.stringify({ actor: `Admin:${adminUser ?? 'NOC'}` }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        alert(json.error ?? 'Gagal memproses keputusan');
      }
    } finally {
      setBusyTicketId(null);
    }
  }, [adminUser]);

  const simulateIncident = useCallback(
    async (routerId: string, scenario: 'radius_timeout' | 'bruteforce' | 'wan_down' | 'pppoe_stuck') => {
      const res = await fetch('/api/simulate-incident', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders(),
        body: JSON.stringify({ routerId, scenario }),
      });
      const json = (await res.json()) as { success: boolean; data?: LiveNocSnapshot; error?: string };
      if (json.success && json.data) {
        setSnapshot(json.data);
      } else if (json.error) {
        alert(json.error);
      }
    },
    [],
  );

  const pollNow = useCallback(async () => {
    setPollingNow(true);
    try {
      const res = await fetch('/api/poll-now', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders(),
      });
      const json = (await res.json()) as { success: boolean; data?: LiveNocSnapshot; error?: string };
      if (json.success && json.data) {
        setSnapshot(json.data);
      }
    } finally {
      setPollingNow(false);
    }
  }, []);

  const addRouter = useCallback(async (payload: NewRouterPayload) => {
    const res = await fetch('/api/routers', {
      method: 'POST',
      credentials: 'include',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    });
    const json = (await res.json()) as {
      success: boolean;
      data?: { routerId: string; snapshot: LiveNocSnapshot };
      error?: string;
    };
    if (!res.ok || !json.success) {
      throw new Error(json.error ?? 'Gagal menambahkan router');
    }
    if (json.data?.snapshot) {
      setSnapshot(json.data.snapshot);
    }
    return json.data?.routerId ?? '';
  }, []);

  const deleteRouter = useCallback(async (routerId: string) => {
    const res = await fetch(`/api/routers/${encodeURIComponent(routerId)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: getAuthHeaders(),
    });
    const json = (await res.json()) as {
      success: boolean;
      data?: { snapshot: LiveNocSnapshot };
      error?: string;
    };
    if (!res.ok || !json.success) {
      throw new Error(json.error ?? 'Gagal menghapus router');
    }
    if (json.data?.snapshot) {
      setSnapshot(json.data.snapshot);
    }
  }, []);

  const updateRouterConfig = useCallback(async (routerId: string, patch: RouterConfigPatch) => {
    const res = await fetch(`/api/routers/${encodeURIComponent(routerId)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    const json = (await res.json()) as {
      success: boolean;
      data?: { routerId: string; snapshot: LiveNocSnapshot };
      error?: string;
    };
    if (!res.ok || !json.success) {
      throw new Error(json.error ?? 'Gagal menyimpan konfigurasi router');
    }
    if (json.data?.snapshot) {
      setSnapshot(json.data.snapshot);
    }
  }, []);

  const testRouterConnection = useCallback(async (routerId: string, override: RouterConfigPatch) => {
    const res = await fetch(`/api/routers/${encodeURIComponent(routerId)}/test`, {
      method: 'POST',
      credentials: 'include',
      headers: getAuthHeaders(),
      body: JSON.stringify(override),
    });
    const json = (await res.json()) as { success: boolean; data?: LiveRouterTelemetry; error?: string };
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error ?? 'Tes koneksi gagal');
    }
    return json.data;
  }, []);

  const askAgentAi = useCallback(async (routerId: string, question: string) => {
    const res = await fetch(`/api/agents/${encodeURIComponent(routerId)}/ask`, {
      method: 'POST',
      credentials: 'include',
      headers: getAuthHeaders(),
      body: JSON.stringify({ question }),
    });
    const json = (await res.json()) as {
      success: boolean;
      data?: { reply: string; source: string; snapshot?: LiveNocSnapshot };
      error?: string;
    };
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error ?? 'Gagal menghubungi agen AI');
    }
    if (json.data.snapshot) {
      setSnapshot(json.data.snapshot);
    }
    return json.data;
  }, []);

  const pingNow = useCallback(async () => {
    const res = await fetch('/api/ping-now', {
      method: 'POST',
      credentials: 'include',
      headers: getAuthHeaders(),
    });
    const json = (await res.json()) as { success: boolean; data?: LiveNocSnapshot };
    if (json.success && json.data) {
      setSnapshot(json.data);
    }
  }, []);

  const updateAlertSettings = useCallback(async (patch: Partial<Omit<LiveAlertSettings, 'waTokenConfigured'>>) => {
    const res = await fetch('/api/alerts/settings', {
      method: 'PUT',
      credentials: 'include',
      headers: getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    const json = (await res.json()) as {
      success: boolean;
      data?: { settings: LiveAlertSettings; snapshot: LiveNocSnapshot };
      error?: string;
    };
    if (!res.ok || !json.success) {
      throw new Error(json.error ?? 'Gagal menyimpan pengaturan alert WA');
    }
    if (json.data?.snapshot) {
      setSnapshot(json.data.snapshot);
    }
    return json.data?.settings;
  }, []);

  const sendTestWhatsapp = useCallback(async (target?: string) => {
    const res = await fetch('/api/alerts/test-wa', {
      method: 'POST',
      credentials: 'include',
      headers: getAuthHeaders(),
      body: JSON.stringify(target ? { target } : {}),
    });
    const json = (await res.json()) as { success: boolean; data?: { ok: boolean; detail: string }; error?: string };
    if (!res.ok || !json.success) {
      throw new Error(json.error ?? 'Gagal mengirim pesan tes WA');
    }
    return json.data?.detail ?? 'Pesan tes WA terkirim';
  }, []);

  const askSpvNoc = useCallback(async (question: string, focusRouterId?: string) => {
    const res = await fetch('/api/spv/ask', {
      method: 'POST',
      credentials: 'include',
      headers: getAuthHeaders(),
      body: JSON.stringify({ question, ...(focusRouterId ? { focusRouterId } : {}) }),
    });
    const json = (await res.json()) as {
      success: boolean;
      data?: { reply: string; source: string; snapshot?: LiveNocSnapshot };
      error?: string;
    };
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error ?? 'Gagal menghubungi SPV NOC');
    }
    if (json.data.snapshot) {
      setSnapshot(json.data.snapshot);
    }
    return json.data;
  }, []);

  const sendSpvSummaryWa = useCallback(async (target?: string) => {
    const res = await fetch('/api/spv/send-summary-wa', {
      method: 'POST',
      credentials: 'include',
      headers: getAuthHeaders(),
      body: JSON.stringify(target ? { target } : {}),
    });
    const json = (await res.json()) as {
      success: boolean;
      data?: { ok: boolean; detail: string; snapshot?: LiveNocSnapshot };
      error?: string;
    };
    if (!res.ok || !json.success) {
      throw new Error(json.error ?? 'Gagal mengirim laporan SPV ke WA');
    }
    if (json.data?.snapshot) {
      setSnapshot(json.data.snapshot);
    }
    return json.data?.detail ?? 'Laporan SPV NOC terkirim ke WhatsApp';
  }, []);

  const addTopologyLink = useCallback(
    async (payload: {
      fromRouterId: string;
      fromInterface: string;
      toRouterId: string;
      toInterface: string;
      label?: string;
      fiberType?: LiveFiberLinkType;
    }) => {
      const res = await fetch('/api/topology/links', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as {
        success: boolean;
        data?: { link: LiveTopologyLink; snapshot: LiveNocSnapshot };
        error?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? 'Gagal menarik kabel topologi');
      }
      if (json.data?.snapshot) setSnapshot(json.data.snapshot);
    },
    [],
  );

  const deleteTopologyLink = useCallback(async (linkId: string) => {
    const res = await fetch(`/api/topology/links/${encodeURIComponent(linkId)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: getAuthHeaders(),
    });
    const json = (await res.json()) as { success: boolean; data?: { snapshot: LiveNocSnapshot }; error?: string };
    if (!res.ok || !json.success) {
      throw new Error(json.error ?? 'Gagal menghapus kabel');
    }
    if (json.data?.snapshot) setSnapshot(json.data.snapshot);
  }, []);

  const saveTopologyPositions = useCallback(async (positions: LiveTopologyNodePosition[]) => {
    const res = await fetch('/api/topology/positions', {
      method: 'PUT',
      credentials: 'include',
      headers: getAuthHeaders(),
      body: JSON.stringify({ positions }),
    });
    const json = (await res.json()) as { success: boolean; data?: { snapshot: LiveNocSnapshot } };
    if (json.success && json.data?.snapshot) setSnapshot(json.data.snapshot);
  }, []);

  const addAiMemoryFact = useCallback(async (text: string, topic = 'SOP & Topologi') => {
    const res = await fetch('/api/memory/facts', {
      method: 'POST',
      credentials: 'include',
      headers: getAuthHeaders(),
      body: JSON.stringify({ text, topic }),
    });
    const json = (await res.json()) as { success: boolean; data?: { snapshot: LiveNocSnapshot }; error?: string };
    if (!res.ok || !json.success) {
      throw new Error(json.error ?? 'Gagal menyimpan memori AI');
    }
    if (json.data?.snapshot) setSnapshot(json.data.snapshot);
  }, []);

  const deleteAiMemoryFact = useCallback(async (factId: string) => {
    const res = await fetch(`/api/memory/facts/${encodeURIComponent(factId)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: getAuthHeaders(),
    });
    const json = (await res.json()) as { success: boolean; data?: { snapshot: LiveNocSnapshot }; error?: string };
    if (!res.ok || !json.success) {
      throw new Error(json.error ?? 'Gagal menghapus memori AI');
    }
    if (json.data?.snapshot) setSnapshot(json.data.snapshot);
  }, []);

  const searchCustomers = useCallback(async (query: string): Promise<LiveCustomerLookupResult> => {
    const res = await fetch(`/api/customers/search?q=${encodeURIComponent(query.trim())}`, {
      credentials: 'include',
      headers: getAuthHeaders(),
    });
    const json = (await res.json()) as { success: boolean; data?: LiveCustomerLookupResult; error?: string };
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error ?? 'Gagal mencari pelanggan');
    }
    return json.data;
  }, []);

  const runRscBackupNow = useCallback(async (): Promise<LiveRscBackupSummary> => {
    const res = await fetch('/api/backups/rsc/run', {
      method: 'POST',
      credentials: 'include',
      headers: getAuthHeaders(),
    });
    const json = (await res.json()) as {
      success: boolean;
      data?: { summary: LiveRscBackupSummary; snapshot: LiveNocSnapshot };
      error?: string;
    };
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error ?? 'Gagal menjalankan backup .rsc');
    }
    if (json.data.snapshot) setSnapshot(json.data.snapshot);
    return json.data.summary;
  }, []);

  const fetchRscPreview = useCallback(async (fileName: string): Promise<string> => {
    const res = await fetch(`/api/backups/rsc/files/${encodeURIComponent(fileName)}`, {
      credentials: 'include',
      headers: getAuthHeaders(),
    });
    const json = (await res.json()) as { success: boolean; data?: { content: string }; error?: string };
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error ?? 'Gagal membaca isi file .rsc');
    }
    return json.data.content;
  }, []);

  return {
    authState,
    adminUser,
    login,
    logout,
    changePassword,
    snapshot,
    connected,
    busyTicketId,
    pollingNow,
    pollNow,
    pingNow,
    decideApproval,
    simulateIncident,
    addRouter,
    deleteRouter,
    updateRouterConfig,
    testRouterConnection,
    askAgentAi,
    askSpvNoc,
    sendSpvSummaryWa,
    addTopologyLink,
    deleteTopologyLink,
    saveTopologyPositions,
    addAiMemoryFact,
    deleteAiMemoryFact,
    searchCustomers,
    runRscBackupNow,
    fetchRscPreview,
    updateAlertSettings,
    sendTestWhatsapp,
  };
}
