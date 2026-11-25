import { useEffect, useState } from 'react';

interface NmsOltRow {
  name: string;
  host: string;
  liveOk: boolean;
  error: string | null;
  totalOnus: number;
  onlineOnus: number;
  offlineOnus: number;
}

interface NmsAlarmRow {
  id?: string | number;
  kind?: string;
  title?: string;
  detail?: string;
}

interface NmsHealthSummary {
  oltsTotal: number;
  oltsReachable: number;
  totalOnus: number;
  onlineOnus: number;
  offlineOnus: number;
  activeAlarmsCount: number;
  olts: NmsOltRow[];
  activeAlarms: NmsAlarmRow[];
}

interface NmsPendingActionItem {
  id: string;
  actionType: 'reboot_modem' | 'ubah_wifi_pelanggan';
  summary: string;
  expiresAt: string;
  target: {
    oltName: string;
    oltHost: string;
    index: string;
    mac: string;
    onuName: string;
  };
  wifiParams?: {
    ssid?: string;
    password?: string;
  };
}

interface NmsCustomerItem {
  oltName: string;
  oltHost: string;
  index: string;
  name: string;
  mac: string;
  status: string;
  rxDbm: number | null;
  rxDrop: boolean;
  pppoeUsername: string | null;
  pppoeIp: string | null;
  pppoeUptime: string | null;
  txMbps: number | null;
  rxMbps: number | null;
  routerName: string | null;
}

interface NmsWifiParsed {
  ssid: string | null;
  model: string | null;
  serial: string | null;
  devices: { hostName: string; ip: string; mac: string; rssi: string }[];
}

export function NmsOltPanel() {
  const [loadingHealth, setLoadingHealth] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [summary, setSummary] = useState<NmsHealthSummary | null>(null);
  const [pendingActions, setPendingActions] = useState<NmsPendingActionItem[]>([]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [customers, setCustomers] = useState<NmsCustomerItem[]>([]);
  const [wifiTarget, setWifiTarget] = useState<{ label: string; parsed: NmsWifiParsed } | null>(null);
  const [wifiFormMac, setWifiFormMac] = useState<string | null>(null);
  const [newSsid, setNewSsid] = useState('');
  const [newPass, setNewPass] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const loadHealth = async () => {
    setLoadingHealth(true);
    try {
      const res = await fetch('/api/nms/health', { credentials: 'include' });
      const json = (await res.json()) as {
        success: boolean;
        data?: { configured: boolean; summary: NmsHealthSummary | null; pendingActions: NmsPendingActionItem[] };
        error?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? 'Gagal memuat status ADT Monitoring NMS');
      }
      setConfigured(Boolean(json.data?.configured));
      setSummary(json.data?.summary ?? null);
      setPendingActions(json.data?.pendingActions ?? []);
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : 'Gagal terhubung ke ADT Monitoring' });
    } finally {
      setLoadingHealth(false);
    }
  };

  useEffect(() => {
    void loadHealth();
  }, []);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = query.trim();
    if (clean.length < 2 || searching) return;
    setSearching(true);
    setFeedback(null);
    setWifiTarget(null);
    try {
      const res = await fetch(`/api/nms/customers?q=${encodeURIComponent(clean)}`, { credentials: 'include' });
      const json = (await res.json()) as {
        success: boolean;
        data?: { items: NmsCustomerItem[] };
        error?: string;
      };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Gagal mencari ONU');
      setCustomers(json.data?.items ?? []);
      if ((json.data?.items ?? []).length === 0) {
        setFeedback({ ok: false, text: `Tidak ditemukan ONU/pelanggan cocok untuk "${clean}".` });
      }
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : 'Pencarian gagal' });
    } finally {
      setSearching(false);
    }
  };

  const handleCheckWifi = async (lookupKey: string, label: string) => {
    setBusyAction(`wifi-${lookupKey}`);
    setFeedback(null);
    try {
      const res = await fetch(`/api/nms/wifi?q=${encodeURIComponent(lookupKey)}`, { credentials: 'include' });
      const json = (await res.json()) as {
        success: boolean;
        data?: { parsed: NmsWifiParsed };
        error?: string;
      };
      if (!res.ok || !json.success || !json.data) throw new Error(json.error ?? 'Gagal membaca GenieACS');
      setWifiTarget({ label, parsed: json.data.parsed });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : 'Gagal cek Wi-Fi modem' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRequestReboot = async (lookupKey: string) => {
    setBusyAction(`reboot-${lookupKey}`);
    setFeedback(null);
    try {
      const res = await fetch('/api/nms/actions/reboot', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: lookupKey }),
      });
      const json = (await res.json()) as {
        success: boolean;
        data?: { pendingActions: NmsPendingActionItem[]; formattedText: string };
        error?: string;
      };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Gagal verifikasi reboot');
      setPendingActions(json.data?.pendingActions ?? []);
      setFeedback({ ok: true, text: '🔒 Verifikasi MAC & Port OK! Silakan klik Konfirmasi di bawah untuk mengeksekusi reboot.' });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : 'Gagal menyiapkan reboot' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRequestWifiChange = async (lookupKey: string) => {
    setBusyAction(`setwifi-${lookupKey}`);
    setFeedback(null);
    try {
      const res = await fetch('/api/nms/actions/wifi', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: lookupKey,
          ...(newSsid.trim() ? { ssid: newSsid.trim() } : {}),
          ...(newPass ? { password: newPass } : {}),
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        data?: { pendingActions: NmsPendingActionItem[] };
        error?: string;
      };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Gagal menyiapkan perubahan Wi-Fi');
      setPendingActions(json.data?.pendingActions ?? []);
      setWifiFormMac(null);
      setNewSsid('');
      setNewPass('');
      setFeedback({ ok: true, text: '🔒 Validasi SSID/Password OK! Silakan klik Konfirmasi di bawah untuk mengirim ke GenieACS.' });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : 'Gagal menyiapkan ubah Wi-Fi' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleConfirmOrCancel = async (actionId: string, decision: 'confirm' | 'cancel') => {
    setBusyAction(`${decision}-${actionId}`);
    setFeedback(null);
    try {
      const res = await fetch(`/api/nms/actions/${encodeURIComponent(actionId)}/${decision}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as {
        success: boolean;
        data?: { pendingActions: NmsPendingActionItem[]; formattedText: string };
        error?: string;
      };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Aksi gagal');
      setPendingActions(json.data?.pendingActions ?? []);
      setFeedback({
        ok: true,
        text: decision === 'confirm' ? `✅ Aksi ${actionId} berhasil dieksekusi!` : `❌ Aksi ${actionId} dibatalkan.`,
      });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : 'Gagal memproses konfirmasi' });
    } finally {
      setBusyAction(null);
    }
  };

  if (!configured && !loadingHealth) {
    return (
      <div className="noc-spv-reports">
        <p style={{ fontSize: '0.84rem', color: '#475569' }}>
          📡 Integrasi ADT Monitoring NMS belum aktif. Tambahkan <code>NMS_BASE_URL</code>, <code>NMS_USERNAME</code>, dan{' '}
          <code>NMS_PASSWORD</code> di <code>.env</code> server lalu restart service.
        </p>
      </div>
    );
  }

  return (
    <div className="noc-spv-reports">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <small style={{ color: '#475569' }}>
          📡 Terhubung via loopback lokal <code>127.0.0.1:8080</code> (OLT HiOSO/HSGQ + GenieACS TR-069)
        </small>
        <button type="button" className="noc-btn-sim" disabled={loadingHealth} onClick={() => void loadHealth()}>
          {loadingHealth ? 'Memuat…' : '🔄 Refresh OLT'}
        </button>
      </div>

      {summary && (
        <div className="noc-metrics-grid" style={{ marginBottom: '10px' }}>
          <div>
            <span>OLT Terjangkau</span>
            <strong>
              {summary.oltsReachable}/{summary.oltsTotal} OLT
            </strong>
          </div>
          <div>
            <span>ONU Online / Offline</span>
            <strong>
              {summary.onlineOnus} On · {summary.offlineOnus} Off
            </strong>
          </div>
          <div>
            <span>Alarm Jaringan Aktif</span>
            <strong style={{ color: summary.activeAlarmsCount > 0 ? '#dc2626' : '#15803d' }}>
              {summary.activeAlarmsCount} alarm
            </strong>
          </div>
        </div>
      )}

      {pendingActions.length > 0 && (
        <div style={{ marginBottom: '10px' }}>
          {pendingActions.map((act) => (
            <div key={act.id} className="noc-card" style={{ background: '#fffbeb', borderColor: '#fde68a' }}>
              <div className="noc-card-head">
                <strong>🔒 Konfirmasi Operator [{act.id}]</strong>
                <small>{act.actionType === 'reboot_modem' ? 'REBOOT MODEM' : 'UBAH WIFI'}</small>
              </div>
              <p style={{ margin: '4px 0', fontSize: '0.82rem' }}>{act.summary}</p>
              <small style={{ display: 'block', color: '#64748b', marginBottom: '6px' }}>
                Target: {act.target.oltName} ({act.target.index}) · MAC <code>{act.target.mac}</code>
              </small>
              <div className="noc-btn-row">
                <button
                  type="button"
                  className="noc-btn-approve"
                  disabled={busyAction !== null}
                  onClick={() => void handleConfirmOrCancel(act.id, 'confirm')}
                >
                  {busyAction === `confirm-${act.id}` ? 'Mengeksekusi…' : '✅ Konfirmasi Eksekusi'}
                </button>
                <button
                  type="button"
                  className="noc-btn-reject"
                  disabled={busyAction !== null}
                  onClick={() => void handleConfirmOrCancel(act.id, 'cancel')}
                >
                  ❌ Batal
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <form className="noc-ai-input-row" onSubmit={(e) => void handleSearch(e)} style={{ marginBottom: '10px' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cari pelanggan OLT (nama, username PPPoE, atau MAC ONU)…"
          disabled={searching}
        />
        <button type="submit" className="noc-btn-approve" disabled={searching || query.trim().length < 2}>
          {searching ? 'Mencari…' : '🔍 Cek ONU'}
        </button>
      </form>

      {feedback && <p className={`noc-feedback ${feedback.ok ? 'is-ok' : 'is-err'}`}>{feedback.text}</p>}

      {wifiTarget && (
        <div className="noc-card" style={{ background: '#f0f9ff', borderColor: '#bae6fd', marginBottom: '10px' }}>
          <div className="noc-card-head">
            <strong>📶 GenieACS Wi-Fi: {wifiTarget.label}</strong>
            <button type="button" className="noc-link-btn" onClick={() => setWifiTarget(null)}>
              Tutup
            </button>
          </div>
          <p style={{ margin: '4px 0', fontSize: '0.82rem' }}>
            <b>SSID:</b> <code>{wifiTarget.parsed.ssid ?? '-'}</code> · <b>Model:</b> {wifiTarget.parsed.model ?? '-'} ·{' '}
            <b>SN:</b> {wifiTarget.parsed.serial ?? '-'} · <b>Perangkat Aktif:</b> {wifiTarget.parsed.devices.length}
          </p>
          {wifiTarget.parsed.devices.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: '18px', fontSize: '0.78rem' }}>
              {wifiTarget.parsed.devices.map((d, idx) => (
                <li key={`${d.mac}-${idx}`}>
                  {d.hostName} · <code>{d.ip}</code> · <code>{d.mac}</code>
                  {d.rssi !== '-' ? ` · RSSI ${d.rssi}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {customers.map((c) => {
        const key = c.mac || c.pppoeUsername || c.name;
        const isOnline = c.status.toLowerCase() === 'online';
        return (
          <div key={`${c.oltHost}-${c.index}-${c.mac}`} className="noc-spv-report-item">
            <div className="noc-card-head">
              <strong>
                <span className={`noc-status-pill ${isOnline ? 'is-executed' : 'is-rejected'}`} style={{ marginRight: '6px' }}>
                  {c.status.toUpperCase()}
                </span>
                {c.name || c.pppoeUsername || c.mac}
              </strong>
              <small>
                {c.oltName} · {c.index}
              </small>
            </div>
            <p style={{ margin: '4px 0', fontSize: '0.8rem', color: '#334155' }}>
              <b>MAC:</b> <code>{c.mac}</code> · <b>RX:</b>{' '}
              <b style={{ color: c.rxDrop || (c.rxDbm !== null && c.rxDbm <= -25) ? '#dc2626' : '#0f766e' }}>
                {c.rxDbm !== null ? `${c.rxDbm} dBm` : '-'}
              </b>
              {c.pppoeUsername ? ` · PPPoE: ${c.pppoeUsername} (${c.pppoeIp ?? '-'}) · Uptime ${c.pppoeUptime ?? '-'}` : ''}
            </p>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
              <button
                type="button"
                className="noc-btn-sim"
                disabled={busyAction !== null}
                onClick={() => void handleCheckWifi(key, c.name || key)}
              >
                {busyAction === `wifi-${key}` ? 'Memanggil TR-069…' : '📶 Cek Wi-Fi'}
              </button>
              <button
                type="button"
                className="noc-btn-sim"
                disabled={busyAction !== null}
                onClick={() => void handleRequestReboot(key)}
              >
                {busyAction === `reboot-${key}` ? 'Verifikasi…' : '🔄 Reboot Modem'}
              </button>
              <button
                type="button"
                className="noc-btn-sim"
                disabled={busyAction !== null}
                onClick={() => setWifiFormMac(wifiFormMac === key ? null : key)}
              >
                🔑 Ubah Wi-Fi
              </button>
            </div>
            {wifiFormMac === key && (
              <div className="noc-form-grid" style={{ marginTop: '8px', padding: '8px', background: '#f8fafc', borderRadius: '8px' }}>
                <label>
                  <span>SSID Baru (opsional, maks 32)</span>
                  <input value={newSsid} onChange={(e) => setNewSsid(e.target.value)} maxLength={32} placeholder="Kosongkan jika tetap" />
                </label>
                <label>
                  <span>Password Baru (opsional, 8-63 karakter)</span>
                  <input value={newPass} onChange={(e) => setNewPass(e.target.value)} maxLength={63} placeholder="Minimal 8 karakter" />
                </label>
                <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    className="noc-btn-approve"
                    disabled={busyAction !== null || (!newSsid.trim() && !newPass)}
                    onClick={() => void handleRequestWifiChange(key)}
                  >
                    🔒 Siapkan Konfirmasi Ubah Wi-Fi
                  </button>
                  <button type="button" className="noc-btn-sim" onClick={() => setWifiFormMac(null)}>
                    Tutup
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {summary && summary.olts.length > 0 && customers.length === 0 && (
        <div style={{ marginTop: '6px' }}>
          <strong style={{ display: 'block', fontSize: '0.8rem', marginBottom: '6px' }}>Daftar OLT ({summary.olts.length})</strong>
          <div className="noc-iface-grid">
            {summary.olts.map((o) => (
              <div key={o.host} className={`noc-iface-pill ${o.liveOk ? 'is-up' : 'is-down'}`}>
                <strong>{o.name}</strong>
                <small>
                  {o.host} · {o.onlineOnus} On / {o.offlineOnus} Off
                </small>
              </div>
            ))}
          </div>
          {summary.activeAlarms.length > 0 && (
            <div style={{ marginTop: '8px' }}>
              <strong style={{ display: 'block', fontSize: '0.8rem', color: '#dc2626', marginBottom: '4px' }}>
                🚨 Alarm Aktif ({summary.activeAlarms.length})
              </strong>
              {summary.activeAlarms.slice(0, 8).map((a, idx) => (
                <div key={`${a.id ?? idx}`} className="noc-spv-report-item is-critical">
                  <strong>[{String(a.kind ?? 'ALARM').toUpperCase()}] {a.title ?? 'Gangguan OLT/PON'}</strong>
                  {a.detail && <p style={{ margin: '2px 0 0', fontSize: '0.79rem' }}>{a.detail}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
