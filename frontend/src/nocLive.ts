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

export interface LiveRouterConfig {
  id: string;
  name: string;
  deviceModel: string;
  host: string;
  port: number;
  useTls: boolean;
  routerOsVersion: 'v6' | 'v7';
  role: 'core' | 'bras' | 'branch';
  readUsername: string;
  hasCustomReadPassword?: boolean;
  simulated: boolean;
}

export interface LiveTelemetryPoint {
  timestamp: string;
  cpuLoadPercent: number;
  memoryUsedPercent: number;
  reachable: boolean;
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
  bgpPeersEstablished: number;
  bgpPeersTotal: number;
  interfaces: { name: string; running: boolean; disabled: boolean; rxMbps: number; txMbps: number }[];
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
  aiBridge?: LiveAiBridgeState;
}

export interface LiveNocSnapshot {
  updatedAt: string;
  agents: LiveOfficeAgent[];
  approvals: LiveApprovalTicket[];
  globalLogs?: LiveSyslogEntry[];
  radiusAlerts?: LiveRadiusAlert[];
  globalMetrics: { label: string; nilai: string }[];
}

export interface RouterConfigPatch {
  name?: string;
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
    decideApproval,
    simulateIncident,
    addRouter,
    deleteRouter,
    updateRouterConfig,
    testRouterConnection,
    askAgentAi,
  };
}
