import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { GAYA, KANTOR, TAMPIL_PEMILIH_GAYA, type RoomKey } from './config';
import { DAFTAR_GAYA, KUNCI_SIMPAN, cariGaya, gayaAwal, type GayaId } from './gaya/daftar';
import {
  IDLE_LABEL,
  idleAt,
  isNight,
  isoDay,
  lapseAt,
  missionBoard,
  officeDesks,
  params as readParams,
  type DeskState,
  type IdleSpot,
} from './office';
import type { CameraControlApi } from './OfficeScene';
import {
  useNocLive,
  type LiveOfficeAgent,
  type LiveRouterTelemetry,
  type LiveTelemetryPoint,
  type NewRouterPayload,
  type RouterConfigPatch,
} from './nocLive';

const OfficeScene = lazy(() => import('./OfficeScene'));

const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];
const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export default function App() {
  const p = useMemo(() => readParams(new URLSearchParams(location.search)), []);
  const [now, setNow] = useState(() => new Date());
  const [t, setT] = useState(0);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [fleetOpen, setFleetOpen] = useState(false);
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditTab, setAuditTab] = useState<'approvals' | 'logs'>('logs');
  const [accountOpen, setAccountOpen] = useState(false);
  const [autoTour, setAutoTour] = useState(false);
  const [miniExpanded, setMiniExpanded] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth > 767 : true,
  );

  const drive = useRef<((t: number) => void) | null>(null);
  const cameraApi = useRef<CameraControlApi | null>(null);
  const anchors = useRef(new Map<string, HTMLElement>());
  const boardAnchor = useRef<HTMLElement | null>(null);

  const {
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
  } = useNocLive();

  const [gaya, setGaya] = useState<GayaId>(() => {
    let simpanan: string | null = null;
    try {
      simpanan = localStorage.getItem(KUNCI_SIMPAN);
    } catch {
      /* penyimpanan diblokir */
    }
    // Upgrade legacy default 'hologram' seamlessly to 'datacenter' unless URL explicitly specifies ?gaya=
    const urlGaya = new URLSearchParams(location.search).get('gaya');
    if (!urlGaya && (!simpanan || simpanan === 'hologram')) {
      return GAYA;
    }
    return gayaAwal(urlGaya, simpanan, GAYA);
  });
  const [pilihBuka, setPilihBuka] = useState(false);

  const gantiGaya = (id: GayaId) => {
    setGaya(id);
    setPilihBuka(false);
    try {
      localStorage.setItem(KUNCI_SIMPAN, id);
    } catch {
      /* abaikan */
    }
    const q = new URLSearchParams(location.search);
    q.set('gaya', id);
    history.replaceState(null, '', `${location.pathname}?${q}`);
  };
  const g = cariGaya(gaya);

  useEffect(() => {
    if (p.rec) {
      const w = window as unknown as { __koFrame?: (t: number) => boolean };
      w.__koFrame = (x: number) => {
        flushSync(() => setT(x));
        drive.current?.(x);
        return !!drive.current;
      };
      return () => void delete w.__koFrame;
    }
    const start = performance.now();
    const id = window.setInterval(() => {
      setT((performance.now() - start) / 1000);
      setNow(new Date());
    }, 100);
    return () => window.clearInterval(id);
  }, [p.rec]);

  const lapse = p.lapse ? lapseAt(t) : null;
  const time = lapse?.time ?? p.time ?? hm(now);

  const desks: DeskState[] = useMemo(() => {
    if (snapshot && snapshot.agents.length > 0 && !p.lapse) {
      return snapshot.agents.map((ag) => ({
        desk: { key: ag.key, room: ag.ruang, color: ag.warna, x: ag.x, z: ag.z },
        agen: {
          key: ag.key,
          nama: ag.nama,
          tugas: ag.tugas,
          ruang: ag.ruang,
          warna: ag.warna,
          x: ag.x,
          z: ag.z,
        },
        doing: { activity: ag.activity, label: ag.activityLabel },
        bubble: ag.ringkasan.length <= 115 ? ag.ringkasan : `${ag.ringkasan.slice(0, 112)}…`,
        waiting: ag.menunggu,
        urgent: ag.mendesak,
      }));
    }
    return officeDesks(isoDay(now), time, p.alwaysWork);
  }, [snapshot, p.lapse, p.alwaysWork, now, time]);

  const board = useMemo(() => {
    if (snapshot && !p.lapse) {
      return {
        items: desks.flatMap((d) =>
          d.waiting.map((text) => ({ key: d.agen.key, name: d.agen.nama, color: d.agen.warna, text })),
        ),
        metrics: snapshot.globalMetrics,
      };
    }
    return missionBoard(desks);
  }, [snapshot, desks, p.lapse]);

  const openDesk = openKey ? desks.find((d) => d.desk.key === openKey) ?? null : null;
  const openLiveAgent: LiveOfficeAgent | null =
    openKey && snapshot ? snapshot.agents.find((a) => a.key === openKey) ?? null : null;

  // --- Admin Login Gate ---
  if (authState === 'loading') {
    return (
      <div className="noc-login-wrap">
        <div className="noc-login-card">
          <div className="noc-login-badge">MOMO NET DATACENTER NOC</div>
          <h1>Memverifikasi Sesi Admin…</h1>
        </div>
      </div>
    );
  }

  if (authState !== 'authenticated') {
    return <LoginGate onLogin={login} />;
  }

  const night = isNight(time);
  const withBubble = desks.filter((d) => d.bubble);
  const spotKey = withBubble.length ? withBubble[Math.floor(t / 2.5) % withBubble.length]!.desk.key : null;
  const working = desks.filter((d) => ['kerja', 'laporan', 'belajar'].includes(d.doing.activity)).length;
  const pendingTotal = snapshot
    ? snapshot.approvals.filter((a) => a.status === 'PENDING').length
    : board.items.length;
  const radiusAlerts = snapshot?.radiusAlerts ?? [];
  const latar = g.latar && (night ? g.latar.malam : g.latar.siang);

  return (
    <div
      className="ko"
      data-night={night || !!g.malam || undefined}
      data-gaya={gaya}
      style={latar ? { background: latar } : undefined}
    >
      <div className="ko-stage">
        <Suspense fallback={<div className="ko-loading">Menyiapkan Datacenter AI NOC…</div>}>
          <OfficeScene
            desks={desks}
            night={night}
            boardCount={Math.min(board.items.length + radiusAlerts.length, 8)}
            anchors={anchors}
            boardAnchor={boardAnchor}
            cameraApi={cameraApi}
            autoTour={autoTour}
            cinematic
            manual={p.rec}
            drive={drive}
            gaya={gaya}
          />
        </Suspense>
        {g.tiltShift && <div className="ko-tilt" aria-hidden="true" />}
        <div className="ko-layer">
          {desks.map((d) => {
            const liveAg = snapshot?.agents.find((a) => a.key === d.desk.key);
            return (
              <Tag
                key={d.desk.key}
                d={d}
                aiLinked={Boolean(liveAg?.aiBridge?.linked)}
                spot={spotKey === d.desk.key}
                idle={d.doing.activity === 'siaga' ? idleAt(d.desk.key, t).spot : null}
                refFn={(el) => (el ? anchors.current.set(d.desk.key, el) : anchors.current.delete(d.desk.key))}
                onOpen={() => {
                  cameraApi.current?.focusAgent(d.desk.key);
                  setOpenKey(d.desk.key);
                }}
              />
            );
          })}
          <span className="ko-board-pin" ref={(el) => void (boardAnchor.current = el)}>
            NOC Wall
          </span>
        </div>
      </div>

      <header className="ko-hud">
        <div className="ko-brand" style={{ pointerEvents: 'auto' }}>
          <img src="/adt-logo.png" alt="ADT Alazka Digital Tech" className="noc-hud-logo" />
          <span
            className="ko-live"
            style={{ background: connected ? '#22c55e' : '#f59e0b' }}
            title={connected ? 'Terhubung ke AI NOC WebSocket Live' : 'Menghubungkan…'}
          />
          <div className="noc-brand-text">
            <b>{KANTOR.nama}</b>
            <small>
              {connected ? 'LIVE' : 'SYNC'} · {working}/{desks.length} agen · {pendingTotal} approval
            </small>
          </div>
          {!p.rec && (
            <div className="noc-hud-actions">
              <button
                type="button"
                className="noc-fleet-btn"
                onClick={() => setFleetOpen((v) => !v)}
                title="Buka daftar & pengaturan IP semua MikroTik"
              >
                📡 <span className="noc-btn-lbl">{desks.length} Router</span>
                <span className="noc-btn-short">{desks.length}</span>
              </button>
              <button
                type="button"
                className="noc-fleet-btn"
                onClick={() => {
                  setAuditTab(radiusAlerts.length > 0 ? 'logs' : 'approvals');
                  setAuditOpen(true);
                }}
                title="Buka Syslog Global & Riwayat Approval"
              >
                📜 <span className="noc-btn-lbl">Log &amp; Audit</span>
                {pendingTotal > 0 ? ` (${pendingTotal})` : ''}
              </button>
              <button
                type="button"
                className="noc-fleet-btn"
                onClick={() => setAccountOpen(true)}
                title="Pengaturan akun admin & logout"
              >
                🔐 <span className="noc-btn-lbl">{adminUser ?? 'Admin'}</span>
              </button>
            </div>
          )}
        </div>
        <div className="ko-clock">
          <b>{time.replace(':', '.')}</b>
          <small>
            {HARI[now.getDay()]}, {now.getDate()} {BULAN[now.getMonth()]} {now.getFullYear()}
          </small>
        </div>
      </header>

      {/* Priority #1 Banner: RADIUS Timeout Alerts */}
      {radiusAlerts.length > 0 && (
        <div className="noc-radius-banner" role="alert">
          <strong>🚨 RADIUS TIMEOUT TERDETEKSI ({radiusAlerts.reduce((a, b) => a + b.count, 0)}x)</strong>
          <div className="noc-radius-chips">
            {radiusAlerts.map((ra) => (
              <button
                key={ra.routerId}
                type="button"
                onClick={() => {
                  cameraApi.current?.focusAgent(ra.routerId);
                  setOpenKey(ra.routerId);
                }}
              >
                {ra.routerName}: user &ldquo;{ra.username}&rdquo; ({ra.count}x)
              </button>
            ))}
          </div>
        </div>
      )}

      {fleetOpen && (
        <aside className="noc-fleet-drawer" aria-label="Daftar MikroTik">
          <div className="noc-fleet-head">
            <h3>📡 Inventaris MikroTik ({desks.length})</h3>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              {connected && (
                <>
                  <button
                    type="button"
                    className="noc-mini-action"
                    disabled={pollingNow}
                    onClick={() => void pollNow()}
                    title="Poll semua router sekarang"
                  >
                    {pollingNow ? '⏳' : '🔄'}
                  </button>
                  <button
                    type="button"
                    className="noc-mini-action"
                    onClick={() => setAddFormOpen((v) => !v)}
                    title="Tambah router MikroTik baru"
                  >
                    {addFormOpen ? '−' : '＋'}
                  </button>
                </>
              )}
              <button type="button" onClick={() => setFleetOpen(false)}>
                ✕
              </button>
            </div>
          </div>

          {addFormOpen && connected && (
            <AddRouterInlineForm
              onAdd={async (payload) => {
                const newId = await addRouter(payload);
                setAddFormOpen(false);
                if (newId) setOpenKey(newId);
              }}
            />
          )}

          <ul>
            {desks.map((d) => {
              const liveAg = snapshot?.agents.find((a) => a.key === d.desk.key);
              const tel = liveAg?.telemetry;
              const isSim = liveAg?.routerConfig?.simulated ?? true;
              const hasRadius = (liveAg?.radiusTimeoutCount ?? 0) > 0;
              const statusDot = hasRadius
                ? '#ef4444'
                : !tel
                  ? '#9ca3af'
                  : tel.status === 'healthy'
                    ? '#22c55e'
                    : tel.status === 'warning'
                      ? '#f59e0b'
                      : '#ef4444';
              return (
                <li key={d.desk.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setFleetOpen(false);
                      cameraApi.current?.focusAgent(d.desk.key);
                      setOpenKey(d.desk.key);
                    }}
                  >
                    <span className="noc-status-dot" style={{ background: statusDot }} />
                    <span className="noc-fleet-info">
                      <strong>
                        {d.agen.nama} {hasRadius ? '🚨 RADIUS' : ''}
                      </strong>
                      <small>
                        {liveAg?.routerConfig?.host ?? '-'} · ROS {liveAg?.routerConfig?.routerOsVersion ?? '-'} ·{' '}
                        {isSim ? 'SIMULASI' : 'LIVE'}
                      </small>
                    </span>
                    <span className="noc-fleet-cpu">{tel ? `${tel.cpuLoadPercent}%` : '-'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      )}

      <aside className={`ko-mini ${miniExpanded ? 'is-open' : 'is-collapsed'}`}>
        <button
          type="button"
          className="noc-mini-header-btn"
          onClick={() => setMiniExpanded((v) => !v)}
          aria-expanded={miniExpanded}
        >
          <span>📊 NOC Status {radiusAlerts.length > 0 ? `· 🚨 ${radiusAlerts.length} RADIUS` : `· ${board.metrics[1]?.nilai ?? ''}`}</span>
          <span>{miniExpanded ? '▼' : '▲'}</span>
        </button>
        {miniExpanded && (
          <>
            {radiusAlerts.length > 0 ? (
              <ul>
                {radiusAlerts.slice(0, 3).map((ra) => (
                  <li
                    key={ra.routerId}
                    style={{ cursor: 'pointer', color: '#fda4af' }}
                    onClick={() => setOpenKey(ra.routerId)}
                  >
                    <b>🚨 {ra.routerName}</b>: user &ldquo;{ra.username}&rdquo; radius timeout ({ra.count}x)
                  </li>
                ))}
              </ul>
            ) : board.items.length === 0 ? (
              <p style={{ margin: '4px 0 8px', fontSize: '0.76rem', opacity: 0.82 }}>
                ✅ RADIUS &amp; MikroTik aman. Drag putar 3D · Scroll/pinch zoom.
              </p>
            ) : (
              <ul>
                {board.items.slice(0, 4).map((it, i) => (
                  <li
                    key={i}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setOpenKey(it.key)}
                    title="Klik untuk meninjau & menyetujui tindakan"
                  >
                    <b style={{ color: it.color }}>{it.name}</b> {it.text}
                  </li>
                ))}
              </ul>
            )}
            {board.metrics.length > 0 && (
              <dl>
                {board.metrics.slice(0, 4).map((m, i) => (
                  <div key={i}>
                    <dd>{m.nilai}</dd>
                    <dt>{m.label}</dt>
                  </div>
                ))}
              </dl>
            )}
          </>
        )}
      </aside>

      {/* On-Screen Camera Control Dock + Theme Selector */}
      {!p.rec && (
        <div className="noc-bottom-right">
          <div className="noc-cam-dock" aria-label="Kontrol Kamera 3D">
            <button type="button" onClick={() => cameraApi.current?.zoomIn()} title="Zoom In">
              ＋
            </button>
            <button type="button" onClick={() => cameraApi.current?.zoomOut()} title="Zoom Out">
              −
            </button>
            <button type="button" onClick={() => cameraApi.current?.resetView()} title="Reset Kamera">
              ⟲
            </button>
            <button
              type="button"
              className={autoTour ? 'is-on' : ''}
              onClick={() => setAutoTour((v) => !v)}
              title="Toggle kamera berputar otomatis"
            >
              🎥 {autoTour ? 'Tour ON' : 'Manual'}
            </button>
          </div>

          {TAMPIL_PEMILIH_GAYA && (
            <nav className="ko-gaya-inline" aria-label="Gaya 3D">
              {pilihBuka && (
                <ul>
                  {DAFTAR_GAYA.map((x) => (
                    <li key={x.id}>
                      <button
                        type="button"
                        aria-pressed={x.id === gaya}
                        title={x.ket}
                        onClick={() => gantiGaya(x.id as GayaId)}
                      >
                        {x.nama}
                        {x.jenis === 'paduan' && <small>dunia</small>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="ko-gaya-btn"
                aria-expanded={pilihBuka}
                onClick={() => setPilihBuka((b) => !b)}
              >
                Tema: {g.nama}
              </button>
            </nav>
          )}
        </div>
      )}

      {/* Admin Account & Password Modal */}
      {accountOpen && (
        <AdminAccountModal
          username={adminUser ?? 'admin'}
          onClose={() => setAccountOpen(false)}
          onChangePassword={changePassword}
          onLogout={async () => {
            setAccountOpen(false);
            await logout();
          }}
        />
      )}

      {/* Global Audit & Syslog Center Modal */}
      {auditOpen && (
        <div className="ko-sheet" role="dialog" aria-label="Log dan Audit NOC" onClick={() => setAuditOpen(false)}>
          <div
            className="ko-sheet-in"
            style={{ width: 'min(740px, 96vw)', maxHeight: '86vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>📜 Pusat Log MikroTik (API + Syslog) &amp; Audit Approval</h3>
              <button type="button" onClick={() => setAuditOpen(false)} style={{ marginTop: 0 }}>
                Tutup
              </button>
            </div>
            <div className="noc-tabs">
              <button
                type="button"
                className={auditTab === 'logs' ? 'is-active' : ''}
                onClick={() => setAuditTab('logs')}
              >
                📜 Log Live ({snapshot?.globalLogs?.length ?? 0})
              </button>
              <button
                type="button"
                className={auditTab === 'approvals' ? 'is-active' : ''}
                onClick={() => setAuditTab('approvals')}
              >
                🔒 Riwayat Approval ({snapshot?.approvals.length ?? 0})
              </button>
            </div>

            {auditTab === 'logs' ? (
              <div className="noc-logs">
                <p style={{ margin: '0 0 8px', fontSize: '0.78rem', color: '#475569' }}>
                  ℹ️ Log otomatis ditarik langsung via RouterOS API (<code>/log/print</code>) setiap 15 detik + real-time
                  UDP port <code>5514</code>. Alert <b>RADIUS timeout</b> langsung ditandai merah.
                </p>
                {!snapshot?.globalLogs || snapshot.globalLogs.length === 0 ? (
                  <p style={{ fontSize: '0.85rem', color: '#6a6380' }}>
                    Belum ada log masuk. Pastikan minimal 1 router aktif di Mode Live MikroTik.
                  </p>
                ) : (
                  <ul style={{ maxHeight: '420px' }}>
                    {snapshot.globalLogs.map((lg) => (
                      <li key={lg.id} data-sev={lg.severity}>
                        <code>[{lg.severity.toUpperCase()}]</code>{' '}
                        <span style={{ color: '#38bdf8' }}>[{lg.routerId}]</span> {lg.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <div className="noc-audit-list">
                {!snapshot || snapshot.approvals.length === 0 ? (
                  <p style={{ fontSize: '0.85rem', color: '#6a6380' }}>
                    Belum ada tiket approval.
                  </p>
                ) : (
                  snapshot.approvals.map((tk) => (
                    <div key={tk.id} className="noc-card">
                      <div className="noc-card-head">
                        <strong>
                          #{tk.id} · {tk.routerName}
                        </strong>
                        <span className={`noc-status-pill is-${tk.status.toLowerCase()}`}>{tk.status}</span>
                      </div>
                      <p style={{ margin: '4px 0', fontSize: '0.84rem' }}>{tk.incidentSummary}</p>
                      <pre className="noc-cmd">{tk.proposal.previewCommand}</pre>
                      {tk.executionResult && (
                        <small style={{ display: 'block', color: '#374151', marginBottom: '6px' }}>
                          Hasil: <code>{tk.executionResult}</code>
                        </small>
                      )}
                      <small style={{ color: '#6a6380' }}>
                        Dibuat: {new Date(tk.createdAt).toLocaleString('id-ID')}
                        {tk.decidedBy ? ` · Oleh ${tk.decidedBy}` : ''}
                      </small>
                      {tk.status === 'PENDING' && (
                        <div className="noc-btn-row">
                          <button
                            type="button"
                            className="noc-btn-approve"
                            disabled={busyTicketId === tk.id}
                            onClick={() => void decideApproval(tk.id, 'approve')}
                          >
                            ✅ Setujui &amp; Eksekusi
                          </button>
                          <button
                            type="button"
                            className="noc-btn-reject"
                            disabled={busyTicketId === tk.id}
                            onClick={() => void decideApproval(tk.id, 'reject')}
                          >
                            ❌ Tolak
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Individual Router / Agent Modal */}
      {openDesk && (
        <div
          className="ko-sheet"
          role="dialog"
          aria-label={openDesk.agen.nama}
          onClick={() => setOpenKey(null)}
        >
          <div
            className="ko-sheet-in"
            style={{ width: 'min(690px, 96vw)', maxHeight: '88vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
              <h3 style={{ margin: 0 }}>
                {openDesk.agen.nama} <small>· {openDesk.agen.tugas}</small>
              </h3>
              {openLiveAgent?.routerConfig && (
                <span className={`noc-mode-badge ${openLiveAgent.routerConfig.simulated ? 'is-sim' : 'is-live'}`}>
                  {openLiveAgent.routerConfig.simulated ? 'SIMULASI' : 'LIVE MIKROTIK'}
                </span>
              )}
            </div>
            <p style={{ margin: '6px 0 10px' }}>
              Status Agen: <b>{openDesk.doing.label}</b>
            </p>

            {openLiveAgent?.telemetry && (
              <div className="noc-metrics-grid">
                <div>
                  <span>Board / RouterOS</span>
                  <strong>
                    {openLiveAgent.telemetry.boardName} ({openLiveAgent.telemetry.version})
                  </strong>
                </div>
                <div>
                  <span>CPU / RAM</span>
                  <strong>
                    {openLiveAgent.telemetry.cpuLoadPercent}% / {openLiveAgent.telemetry.memoryUsedPercent}%
                  </strong>
                </div>
                <div>
                  <span>Uptime / Kesehatan</span>
                  <strong>
                    {openLiveAgent.telemetry.uptime}
                    {openLiveAgent.telemetry.temperatureC !== null ? ` · ${openLiveAgent.telemetry.temperatureC}°C` : ''}
                    {openLiveAgent.telemetry.voltageV !== null ? ` · ${openLiveAgent.telemetry.voltageV}V` : ''}
                  </strong>
                </div>
                {openLiveAgent.telemetry.activePppoeCount > 0 && (
                  <div>
                    <span>PPPoE Aktif</span>
                    <strong>{openLiveAgent.telemetry.activePppoeCount} sesi</strong>
                  </div>
                )}
                {openLiveAgent.telemetry.bgpPeersTotal > 0 && (
                  <div>
                    <span>BGP Peers</span>
                    <strong>
                      {openLiveAgent.telemetry.bgpPeersEstablished}/{openLiveAgent.telemetry.bgpPeersTotal} up
                    </strong>
                  </div>
                )}
              </div>
            )}

            {openLiveAgent?.telemetryHistory && openLiveAgent.telemetryHistory.length >= 2 && (
              <TelemetrySparkline history={openLiveAgent.telemetryHistory} />
            )}

            {/* Antigravity AI Live Console (Highlighted for Rangga CCR Momo Net & available on all agents) */}
            {connected && openLiveAgent && (
              <AgentAiConsolePanel
                key={`ai-${openLiveAgent.routerId}`}
                agent={openLiveAgent}
                onAsk={(q) => askAgentAi(openLiveAgent.routerId, q)}
              />
            )}

            {openLiveAgent?.telemetry?.lastError && (
              <p className="ko-sheet-urgent">🔌 Koneksi API: {openLiveAgent.telemetry.lastError}</p>
            )}

            {openDesk.urgent.length > 0 && (
              <p className="ko-sheet-urgent">⚠ Insiden Aktif: {openDesk.urgent.join(' · ')}</p>
            )}

            {openLiveAgent?.telemetry && openLiveAgent.telemetry.interfaces.length > 0 && (
              <div className="noc-ifaces">
                <h4>🌐 Interface ({openLiveAgent.telemetry.interfaces.length})</h4>
                <div className="noc-iface-grid">
                  {openLiveAgent.telemetry.interfaces.slice(0, 12).map((ifc) => (
                    <div key={ifc.name} className={`noc-iface-pill ${ifc.running ? 'is-up' : 'is-down'}`}>
                      <strong>{ifc.name}</strong>
                      <small>
                        {ifc.disabled ? 'DISABLED' : ifc.running ? 'UP' : 'DOWN'} · Rx {ifc.rxMbps} / Tx {ifc.txMbps}{' '}
                        Mbps
                      </small>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {connected && openLiveAgent?.routerConfig && (
              <RouterConfigPanel
                key={openLiveAgent.routerId}
                agent={openLiveAgent}
                canDelete={(snapshot?.agents.length ?? 0) > 1}
                onSave={(patch) => updateRouterConfig(openLiveAgent.routerId, patch)}
                onTest={(patch) => testRouterConnection(openLiveAgent.routerId, patch)}
                onDelete={async () => {
                  await deleteRouter(openLiveAgent.routerId);
                  setOpenKey(null);
                }}
              />
            )}

            {openLiveAgent && openLiveAgent.pendingApprovals.length > 0 && (
              <div className="noc-approvals">
                <h4>🔒 Menunggu Persetujuan / Diagnostik (Human-in-the-Loop)</h4>
                {openLiveAgent.pendingApprovals.map((tk) => (
                  <div key={tk.id} className="noc-card">
                    <div className="noc-card-head">
                      <strong>Tiket #{tk.id}</strong>
                      <span className={`noc-risk noc-risk-${tk.proposal.riskLevel.toLowerCase()}`}>
                        Risiko: {tk.proposal.riskLevel}
                      </span>
                    </div>
                    <p style={{ margin: '6px 0' }}>
                      <b>Masalah:</b> {tk.incidentSummary}
                    </p>
                    <p style={{ margin: '6px 0', fontSize: '0.85rem', color: '#4a4360' }}>
                      <b>Analisis AI:</b> {tk.rootCauseAnalysis}
                    </p>
                    <pre className="noc-cmd">{tk.proposal.previewCommand}</pre>
                    <small style={{ display: 'block', color: '#6a6380', marginBottom: '8px' }}>
                      Rollback: <code>{tk.proposal.rollbackCommand}</code>
                    </small>
                    <div className="noc-btn-row">
                      <button
                        type="button"
                        className="noc-btn-approve"
                        disabled={busyTicketId === tk.id}
                        onClick={() => void decideApproval(tk.id, 'approve')}
                      >
                        {busyTicketId === tk.id ? 'Mengeksekusi…' : '✅ Setujui / Tandai Ditangani'}
                      </button>
                      <button
                        type="button"
                        className="noc-btn-reject"
                        disabled={busyTicketId === tk.id}
                        onClick={() => void decideApproval(tk.id, 'reject')}
                      >
                        ❌ Tutup / Tolak
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {openLiveAgent && openLiveAgent.recentLogs.length > 0 && (
              <div className="noc-logs">
                <h4>📜 Log MikroTik Terakhir ({openLiveAgent.recentLogs.length})</h4>
                <ul>
                  {openLiveAgent.recentLogs.slice(0, 12).map((lg) => (
                    <li key={lg.id} data-sev={lg.severity}>
                      <code>[{lg.severity.toUpperCase()}]</code> {lg.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {connected && openLiveAgent && (
              <div className="noc-drill">
                <small>Uji Simulasi Insiden pada Router Ini (Safe Mode):</small>
                <div className="noc-btn-row">
                  <button
                    type="button"
                    className="noc-btn-sim"
                    onClick={() => void simulateIncident(openLiveAgent.routerId, 'radius_timeout')}
                  >
                    🚨 Simulasi RADIUS Timeout
                  </button>
                  <button
                    type="button"
                    className="noc-btn-sim"
                    onClick={() => void simulateIncident(openLiveAgent.routerId, 'bruteforce')}
                  >
                    🧪 Simulasi Brute-Force SSH
                  </button>
                  <button
                    type="button"
                    className="noc-btn-sim"
                    onClick={() => void simulateIncident(openLiveAgent.routerId, 'wan_down')}
                  >
                    🧪 Simulasi Link ISP Down
                  </button>
                  <button
                    type="button"
                    className="noc-btn-sim"
                    onClick={() => void simulateIncident(openLiveAgent.routerId, 'pppoe_stuck')}
                  >
                    🧪 Simulasi PPPoE Macet
                  </button>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
              <button type="button" onClick={() => setOpenKey(null)}>
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LoginGate({ onLogin }: { onLogin: (u: string, p: string) => Promise<void> }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onLogin(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login gagal');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="noc-login-wrap">
      <form className="noc-login-card" onSubmit={(e) => void handleSubmit(e)}>
        <div className="noc-login-logo-box">
          <img src="/adt-logo.png" alt="ADT Alazka Digital Tech" />
        </div>
        <div className="noc-login-badge">ADT · ALAZKA DIGITAL TECH — DATACENTER NOC</div>
        <h1>🔐 Login Admin NOC</h1>
        <p>Masuk untuk mengakses monitoring 3D MikroTik, log RADIUS live, dan kontrol router.</p>

        <label>
          <span>Username Admin</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>

        <label>
          <span>Password Admin</span>
          <div className="noc-pass-row">
            <input
              type={showPass ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="Masukkan password admin"
              required
            />
            <button type="button" className="noc-pass-eye" onClick={() => setShowPass((v) => !v)}>
              {showPass ? '🙈' : '👁'}
            </button>
          </div>
        </label>

        {error && <p className="noc-feedback is-err">{error}</p>}

        <button type="submit" className="noc-login-submit" disabled={busy}>
          {busy ? 'Memverifikasi…' : 'Masuk ke Datacenter NOC →'}
        </button>
      </form>
    </div>
  );
}

function AdminAccountModal({
  username,
  onClose,
  onChangePassword,
  onLogout,
}: {
  username: string;
  onClose: () => void;
  onChangePassword: (cur: string, nextPass: string, nextUser?: string) => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [newUser, setNewUser] = useState(username);
  const [curPass, setCurPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await onChangePassword(curPass, newPass, newUser);
      setCurPass('');
      setNewPass('');
      setMsg({ ok: true, text: 'Username & password admin berhasil diperbarui!' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'Gagal memperbarui password' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ko-sheet" role="dialog" aria-label="Pengaturan Akun Admin" onClick={onClose}>
      <div className="ko-sheet-in" style={{ width: 'min(460px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
        <h3>🔐 Pengaturan Akun Admin NOC</h3>
        <form onSubmit={(e) => void handleUpdate(e)} className="noc-form-grid" style={{ gridTemplateColumns: '1fr' }}>
          <label>
            <span>Username Admin</span>
            <input value={newUser} onChange={(e) => setNewUser(e.target.value)} required />
          </label>
          <label>
            <span>Password Saat Ini</span>
            <input type="password" value={curPass} onChange={(e) => setCurPass(e.target.value)} required />
          </label>
          <label>
            <span>Password Baru (min. 6 karakter)</span>
            <input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} minLength={6} required />
          </label>
          {msg && <p className={`noc-feedback ${msg.ok ? 'is-ok' : 'is-err'}`}>{msg.text}</p>}
          <div className="noc-btn-row">
            <button type="submit" className="noc-btn-approve" disabled={busy}>
              {busy ? 'Menyimpan…' : '💾 Simpan Password Baru'}
            </button>
            <button type="button" className="noc-btn-reject" onClick={() => void onLogout()}>
              🚪 Logout
            </button>
            <button type="button" onClick={onClose} style={{ marginLeft: 'auto' }}>
              Tutup
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TelemetrySparkline({ history }: { history: readonly LiveTelemetryPoint[] }) {
  const width = 560;
  const height = 56;
  const pad = 4;
  const toPoints = (selector: (pt: LiveTelemetryPoint) => number) =>
    history
      .map((pt, idx) => {
        const x = pad + (idx / Math.max(1, history.length - 1)) * (width - pad * 2);
        const y = height - pad - (Math.min(100, Math.max(0, selector(pt))) / 100) * (height - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  return (
    <div className="noc-spark-box">
      <div className="noc-spark-head">
        <span>📈 Tren CPU &amp; RAM ({history.length} sampel terakhir)</span>
        <span>
          <b style={{ color: '#e4572e' }}>● CPU</b> &nbsp; <b style={{ color: '#3a86ff' }}>● RAM</b>
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="noc-spark-svg" role="img" aria-label="Tren CPU dan RAM">
        <line x1={pad} y1={height / 2} x2={width - pad} y2={height / 2} stroke="#e2d9f3" strokeDasharray="3 3" />
        <polyline fill="none" stroke="#3a86ff" strokeWidth="2" points={toPoints((p) => p.memoryUsedPercent)} />
        <polyline fill="none" stroke="#e4572e" strokeWidth="2.2" points={toPoints((p) => p.cpuLoadPercent)} />
      </svg>
    </div>
  );
}

function AddRouterInlineForm({ onAdd }: { onAdd: (payload: NewRouterPayload) => Promise<void> }) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('8728');
  const [rosVer, setRosVer] = useState<'v6' | 'v7'>('v7');
  const [room, setRoom] = useState<RoomKey>('distribusi');
  const [readUsername, setReadUsername] = useState('noc_readonly');
  const [readPassword, setReadPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || !host.trim()) {
      setErr('Nama router dan IP wajib diisi');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onAdd({
        name: name.trim(),
        host: host.trim(),
        port: Number(port) || 8728,
        useTls: false,
        routerOsVersion: rosVer,
        role: room === 'core' ? 'core' : room === 'security' ? 'bras' : 'branch',
        room,
        readUsername: readUsername.trim() || 'noc_readonly',
        ...(readPassword ? { readPassword } : {}),
        simulated: true,
      });
      setName('');
      setHost('');
      setReadPassword('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal menambah router');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="noc-add-form">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama (mis. RB750-POP-Baru)" />
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '6px' }}>
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="IP (192.168.88.x)" />
        <input value={port} onChange={(e) => setPort(e.target.value)} type="number" placeholder="8728" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        <input value={readUsername} onChange={(e) => setReadUsername(e.target.value)} placeholder="User MikroTik" />
        <input
          value={readPassword}
          onChange={(e) => setReadPassword(e.target.value)}
          type="password"
          placeholder="Password (opsional)"
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        <select value={rosVer} onChange={(e) => setRosVer(e.target.value as 'v6' | 'v7')}>
          <option value="v7">ROS v7</option>
          <option value="v6">ROS v6</option>
        </select>
        <select value={room} onChange={(e) => setRoom(e.target.value as RoomKey)}>
          <option value="core">Backbone CRS</option>
          <option value="security">CCR Pusat</option>
          <option value="distribusi">Cabang RB750</option>
        </select>
      </div>
      {err && <small style={{ color: '#fda4af' }}>{err}</small>}
      <button type="button" className="noc-btn-approve" disabled={busy} onClick={() => void submit()}>
        {busy ? 'Menambah…' : '➕ Simpan Router Baru'}
      </button>
    </div>
  );
}

function RouterConfigPanel({
  agent,
  canDelete,
  onSave,
  onTest,
  onDelete,
}: {
  agent: LiveOfficeAgent;
  canDelete: boolean;
  onSave: (patch: RouterConfigPatch) => Promise<void>;
  onTest: (patch: RouterConfigPatch) => Promise<LiveRouterTelemetry>;
  onDelete: () => Promise<void>;
}) {
  const cfg = agent.routerConfig!;
  const [expanded, setExpanded] = useState(cfg.simulated || !agent.telemetry?.reachable);
  const [host, setHost] = useState(cfg.host);
  const [port, setPort] = useState(String(cfg.port));
  const [useTls, setUseTls] = useState(cfg.useTls);
  const [rosVer, setRosVer] = useState<'v6' | 'v7'>(cfg.routerOsVersion);
  const [readUsername, setReadUsername] = useState(cfg.readUsername);
  const [readPassword, setReadPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [simulated, setSimulated] = useState(cfg.simulated);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const parsedPort = Number(port) || (useTls ? 8729 : 8728);
  const tlsMismatch = (useTls && parsedPort === 8728) || (!useTls && parsedPort === 8729);

  const handleToggleTls = (checked: boolean) => {
    setUseTls(checked);
    if (checked && port.trim() === '8728') {
      setPort('8729');
    } else if (!checked && port.trim() === '8729') {
      setPort('8728');
    }
  };

  const buildPatch = (clearPassword = false): RouterConfigPatch => ({
    host: host.trim(),
    port: parsedPort,
    useTls,
    routerOsVersion: rosVer,
    readUsername: readUsername.trim() || 'noc_readonly',
    ...(clearPassword ? { clearReadPassword: true } : readPassword ? { readPassword } : {}),
    simulated,
  });

  const handleSave = async (clearPassword = false) => {
    setBusy(true);
    setFeedback(null);
    try {
      await onSave(buildPatch(clearPassword));
      if (readPassword || clearPassword) {
        setReadPassword('');
      }
      setFeedback({
        ok: true,
        text: clearPassword
          ? 'Password dikembalikan ke default (.env) & polling diperbarui!'
          : 'Konfigurasi & kredensial tersimpan (terenkripsi) — polling langsung diperbarui!',
      });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : 'Gagal menyimpan' });
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const tel = await onTest(buildPatch());
      if (tel.reachable) {
        setFeedback({
          ok: true,
          text: `Terhubung! ${tel.boardName} (ROS ${tel.version}) · CPU ${tel.cpuLoadPercent}% · RAM ${tel.memoryUsedPercent}% · PPPoE ${tel.activePppoeCount}`,
        });
      } else {
        setFeedback({
          ok: false,
          text: `Gagal terhubung ke ${host}:${parsedPort} (${useTls ? 'TLS' : 'Plain'}) — ${tel.lastError ?? 'Unreachable'}`,
        });
      }
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : 'Tes koneksi gagal' });
    } finally {
      setBusy(false);
    }
  };

  const policyLine =
    rosVer === 'v7'
      ? 'read,test,api,!local,!telnet,!ssh,!ftp,!reboot,!write,!policy,!winbox,!password,!web,!sniff,!sensitive,!romon,!rest-api'
      : 'read,test,api,!local,!telnet,!ssh,!ftp,!reboot,!write,!policy,!winbox,!password,!web,!sniff,!sensitive,!romon';

  // NOTE: MikroTik logging action name ONLY allows letters & numbers (NO hyphen!) -> "ainoc"
  const cliSnippet = [
    `/ip service enable api`,
    `/user group add name=aireadonly policy=${policyLine}`,
    `/user add name=${readUsername || 'noc_readonly'} group=aireadonly address=<IP_SERVER_NOC>/32 password="<PASSWORD_MIKROTIK>"`,
    `/system logging action add name=ainoc target=remote remote=<IP_SERVER_NOC> remote-port=5514`,
    `/system logging add topics=warning action=ainoc`,
    `/system logging add topics=error action=ainoc`,
    `/system logging add topics=critical action=ainoc`,
    `/system logging add topics=radius action=ainoc`,
  ].join('\n');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cliSnippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* fallback abaikan */
    }
  };

  return (
    <div className="noc-config-box">
      <button type="button" className="noc-config-toggle" onClick={() => setExpanded((v) => !v)}>
        <span>⚙️ Konfigurasi Koneksi MikroTik &amp; CLI Setup</span>
        <span>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="noc-config-body">
          <div className="noc-form-grid">
            <label>
              <span>IP / Host MikroTik</span>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.88.x" />
            </label>
            <label>
              <span>Port API (8728 Plain / 8729 SSL)</span>
              <input value={port} onChange={(e) => setPort(e.target.value)} type="number" min={1} max={65535} />
            </label>
            <label>
              <span>Versi RouterOS</span>
              <select value={rosVer} onChange={(e) => setRosVer(e.target.value as 'v6' | 'v7')}>
                <option value="v7">RouterOS v7</option>
                <option value="v6">RouterOS v6</option>
              </select>
            </label>
            <label>
              <span>User Read-Only</span>
              <input value={readUsername} onChange={(e) => setReadUsername(e.target.value)} />
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>
                  Password MikroTik{' '}
                  <small style={{ color: cfg.hasCustomReadPassword ? '#15803d' : '#6a6380', fontWeight: 600 }}>
                    ({cfg.hasCustomReadPassword ? '🔑 Custom GUI tersimpan' : '🔑 Default .env'})
                  </small>
                </span>
                {cfg.hasCustomReadPassword && (
                  <button
                    type="button"
                    className="noc-link-btn"
                    disabled={busy}
                    onClick={() => void handleSave(true)}
                  >
                    Reset ke default
                  </button>
                )}
              </span>
              <div className="noc-pass-row">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={readPassword}
                  onChange={(e) => setReadPassword(e.target.value)}
                  autoComplete="new-password"
                  placeholder={
                    cfg.hasCustomReadPassword
                      ? '•••••••• (kosongkan jika tidak mengubah password)'
                      : 'Isi password baru (kosongkan = pakai default .env)'
                  }
                />
                <button
                  type="button"
                  className="noc-pass-eye"
                  onClick={() => setShowPassword((v) => !v)}
                  title={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                >
                  {showPassword ? '🙈' : '👁'}
                </button>
              </div>
            </label>
          </div>
          <div className="noc-check-row">
            <label>
              <input type="checkbox" checked={!simulated} onChange={(e) => setSimulated(!e.target.checked)} />
              <span>Aktifkan Mode Live MikroTik (matikan simulasi)</span>
            </label>
            <label>
              <input type="checkbox" checked={useTls} onChange={(e) => handleToggleTls(e.target.checked)} />
              <span>API-SSL / TLS (hanya untuk port 8729)</span>
            </label>
          </div>
          {tlsMismatch && (
            <p className="noc-feedback is-warn">
              ⚠{' '}
              {useTls
                ? 'Port 8728 adalah API Plain (non-TLS). Matikan centang API-SSL/TLS atau ubah port ke 8729 agar tidak timeout.'
                : 'Port 8729 biasanya memakai API-SSL/TLS. Centang API-SSL/TLS atau gunakan port 8728 untuk Plain API.'}
            </p>
          )}
          <div className="noc-btn-row">
            <button type="button" className="noc-btn-approve" disabled={busy} onClick={() => void handleSave(false)}>
              {busy ? 'Memproses…' : '💾 Simpan Konfigurasi'}
            </button>
            <button type="button" className="noc-btn-sim" disabled={busy} onClick={() => void handleTest()}>
              🔌 Tes Koneksi Live
            </button>
            {canDelete && (
              <button
                type="button"
                className="noc-btn-reject"
                disabled={busy}
                onClick={() => {
                  if (confirm(`Hapus router ${cfg.name} dari inventaris AI NOC?`)) {
                    void onDelete();
                  }
                }}
                style={{ marginLeft: 'auto', fontSize: '0.75rem', padding: '6px 10px' }}
              >
                🗑 Hapus
              </button>
            )}
          </div>
          {feedback && <p className={`noc-feedback ${feedback.ok ? 'is-ok' : 'is-err'}`}>{feedback.text}</p>}
          <details style={{ marginTop: '8px' }}>
            <summary style={{ cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600 }}>
              📋 Script MikroTik Terminal ({rosVer.toUpperCase()}) — Sudah Perbaikan nama <code>ainoc</code>
            </summary>
            <small style={{ display: 'block', color: '#475569', marginTop: '4px' }}>
              Catatan: Log MikroTik (termasuk RADIUS timeout) <b>sudah otomatis dibaca lewat API <code>/log/print</code></b>.
              Script <code>ainoc</code> di bawah opsional untuk kirim syslog real-time ke UDP 5514.
            </small>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
              <button type="button" className="noc-btn-sim" onClick={() => void handleCopy()}>
                {copied ? '✅ Tersalin!' : '📋 Salin Script'}
              </button>
            </div>
            <pre className="noc-cmd" style={{ fontSize: '0.72rem' }}>
              {cliSnippet}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

function AgentAiConsolePanel({
  agent,
  onAsk,
}: {
  agent: LiveOfficeAgent;
  onAsk: (question: string) => Promise<{ reply: string; source: string }>;
}) {
  const bridge = agent.aiBridge;
  const isLinked = Boolean(bridge?.linked);
  const [expanded, setExpanded] = useState(isLinked);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sendPrompt = async (text: string) => {
    const clean = text.trim();
    if (!clean || busy) return;
    setBusy(true);
    setErr(null);
    setQuestion('');
    try {
      await onAsk(clean);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal menghubungi agen AI');
    } finally {
      setBusy(false);
    }
  };

  const messages = bridge?.messages ?? [];

  return (
    <div className={`noc-ai-box ${isLinked ? 'is-linked' : ''}`}>
      <button type="button" className="noc-ai-toggle" onClick={() => setExpanded((v) => !v)}>
        <span>
          {isLinked ? '⚡ Antigravity AI Terhubung' : '🤖 Konsol AI NOC'} ·{' '}
          <small>{bridge?.agentLabel ?? agent.nama}</small>
        </span>
        <span>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="noc-ai-body">
          {bridge?.lastBriefing && (
            <div className="noc-ai-brief">
              <strong>📡 Status Antigravity Link:</strong> {bridge.lastBriefing}
            </div>
          )}
          <div className="noc-ai-chips">
            <button type="button" disabled={busy} onClick={() => void sendPrompt('Analisa kondisi router sekarang')}>
              📊 Analisa Kondisi
            </button>
            <button type="button" disabled={busy} onClick={() => void sendPrompt('Interface dan OLT mana trafik paling tinggi?')}>
              🌐 Top Trafik OLT
            </button>
            <button type="button" disabled={busy} onClick={() => void sendPrompt('Cek apakah ada radius timeout atau log error')}>
              🚨 Cek RADIUS &amp; Log
            </button>
            <button type="button" disabled={busy} onClick={() => void sendPrompt('Cek suhu, CPU, RAM dan PPPoE aktif')}>
              🌡 Suhu &amp; PPPoE
            </button>
          </div>
          {messages.length > 0 && (
            <div className="noc-ai-chat">
              {messages.slice(-8).map((m) => (
                <div key={m.id} className={`noc-ai-msg is-${m.role}`}>
                  <div className="noc-ai-msg-meta">
                    <b>{m.role === 'user' ? 'Anda' : m.source}</b>
                    <span>{new Date(m.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <pre>{m.text}</pre>
                </div>
              ))}
            </div>
          )}
          <form
            className="noc-ai-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              void sendPrompt(question);
            }}
          >
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={`Tanya ${agent.nama} (mis. cek trafik OLT, PPPoE, suhu, RADIUS)…`}
              disabled={busy}
            />
            <button type="submit" className="noc-btn-approve" disabled={busy || !question.trim()}>
              {busy ? '…' : 'Kirim'}
            </button>
          </form>
          {err && <p className="noc-feedback is-err">{err}</p>}
        </div>
      )}
    </div>
  );
}

function Tag({
  d,
  aiLinked,
  spot,
  idle,
  refFn,
  onOpen,
}: {
  d: DeskState;
  aiLinked: boolean;
  spot: boolean;
  idle: IdleSpot | null;
  refFn: (el: HTMLElement | null) => void;
  onOpen: () => void;
}) {
  const label = idle ? IDLE_LABEL[idle] : d.doing.label;
  const a = d.doing.activity;
  const think =
    d.urgent.length > 0
      ? '🚨'
      : d.waiting.length > 0
        ? '🔒'
        : aiLinked
          ? '⚡AI'
          : null;
  return (
    <div
      className={`ko-tag ${aiLinked ? 'is-ai-linked' : ''}`}
      ref={refFn}
      data-act={a}
      style={{ ['--agent' as string]: d.desk.color }}
    >
      <div className="ko-tag-in">
        {d.bubble && spot && a !== 'pulang' && <p className="ko-bubble">{d.bubble}</p>}
        {think && !(d.bubble && spot) && <span className="ko-think">{think}</span>}
        <div className="ko-tag-row">
          <button type="button" className="ko-name" onClick={onOpen}>
            <span className="ko-dot" />
            <span className="ko-name-main">{d.agen.nama}</span>
            <span className="ko-name-act">{label}</span>
          </button>
          {d.waiting.length > 0 && (
            <button
              type="button"
              className="ko-bang"
              onClick={onOpen}
              aria-label={`${d.waiting.length} tindakan menunggu persetujuan`}
              title="Menunggu Persetujuan Anda!"
            >
              ?
            </button>
          )}
          {d.urgent.length > 0 && <span className="ko-urgent">⚠</span>}
        </div>
      </div>
    </div>
  );
}
