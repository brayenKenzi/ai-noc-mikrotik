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
import type { MonitorPingFeed } from './pingScreenTexture';
import TopologyMapModal from './TopologyMapModal';
import { CustomerLookupPanel, RscBackupVaultPanel } from './SpvToolsTabs';
import { NmsOltPanel } from './NmsOltPanel';
import {
  useNocLive,
  type LiveAgentDutyRole,
  type LiveAlertSettings,
  type LiveCustomerLookupResult,
  type LiveNocSnapshot,
  type LiveOfficeAgent,
  type LiveRouterTelemetry,
  type LiveRscBackupSummary,
  type LiveTelemetryPoint,
  type NewRouterPayload,
  type RouterConfigPatch,
} from './nocLive';

const OfficeScene = lazy(() => import('./OfficeScene'));

// Open-concept Cafe Datacenter seating layout (ensures zero overlap with central SPV NOC desk at 0, 0.55)
const CAFE_SEAT_COORDS: Record<string, readonly [number, number]> = {
  'crs-backbone-01': [-5.3, -1.75],
  'crs-backbone-02': [-3.3, -1.75],
  'core-mongkonai': [-4.35, -0.15],
  'crs-backbone-03': [-5.3, 1.45],
  'crs-backbone-04': [-3.3, 1.45],
  'ccr-momonet-pusat': [0.0, -1.75],
  'rb750-qairen': [3.3, -1.65],
  'rb750-dn-bangomolunow': [5.2, -1.65],
  'rb750-dn-lolan': [4.25, 0.35],
};

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
  const [spvOpen, setSpvOpen] = useState(false);
  const [topoOpen, setTopoOpen] = useState(false);
  const [spvQuickPrompt, setSpvQuickPrompt] = useState<{ text: string; focusRouterId?: string } | null>(null);
  const [fleetOpen, setFleetOpen] = useState(false);
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditTab, setAuditTab] = useState<'approvals' | 'logs'>('logs');
  const [accountOpen, setAccountOpen] = useState(false);
  const [autoTour, setAutoTour] = useState(false);
  const [copiedCmdId, setCopiedCmdId] = useState<string | null>(null);
  const [miniExpanded, setMiniExpanded] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth > 767 : true,
  );

  const copyCliCommand = async (id: string, command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCmdId(id);
      window.setTimeout(() => setCopiedCmdId((prev) => (prev === id ? null : prev)), 2200);
    } catch {
      /* clipboard tidak tersedia */
    }
  };

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
    pingNow,
    decideApproval,
    simulateIncident,
    addRouter,
    deleteRouter,
    updateRouterConfig,
    testRouterConnection,
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
    const spvState = snapshot?.spvNoc;
    const spvAlerts = spvState?.activeAlerts ?? 0;
    const spvDesk: DeskState = {
      desk: { key: 'spv-noc', room: 'security', color: '#fbbf24', x: 0.0, z: 0.55 },
      agen: {
        key: 'spv-noc',
        nama: '👑 SPV NOC',
        tugas: 'AI Supervisor · Semua MikroTik & WA Fonnte',
        ruang: 'security',
        warna: '#fbbf24',
        x: 0.0,
        z: 0.55,
      },
      doing: {
        activity: spvAlerts > 0 ? 'laporan' : 'kerja',
        label: spvAlerts > 0 ? `🚨 ${spvAlerts} anomali` : `👑 AI · ${spvState?.liveRouters ?? 0} live`,
      },
      bubble:
        spvState?.reports[0]?.message ??
        `Mengawasi ${spvState?.totalRouters ?? 9} router & siap lapor anomali via WA Fonnte.`,
      waiting: [],
      urgent: spvAlerts > 0 ? [`${spvAlerts} anomali aktif di jaringan`] : [],
    };

    if (snapshot && snapshot.agents.length > 0 && !p.lapse) {
      const mappedAgents: DeskState[] = snapshot.agents.map((ag) => {
        const seat = CAFE_SEAT_COORDS[ag.key];
        const sx = seat ? seat[0] : ag.x;
        const sz = seat ? seat[1] : ag.z;
        return {
          desk: { key: ag.key, room: ag.ruang, color: ag.warna, x: sx, z: sz },
          agen: {
            key: ag.key,
            nama: ag.nama,
            tugas: ag.tugas,
            ruang: ag.ruang,
            warna: ag.warna,
            x: sx,
            z: sz,
          },
          doing: { activity: ag.activity, label: ag.activityLabel },
          bubble: ag.ringkasan.length <= 115 ? ag.ringkasan : `${ag.ringkasan.slice(0, 112)}…`,
          waiting: ag.menunggu,
          urgent: ag.mendesak,
        };
      });
      return [spvDesk, ...mappedAgents];
    }
    return [spvDesk, ...officeDesks(isoDay(now), time, p.alwaysWork)];
  }, [snapshot, p.lapse, p.alwaysWork, now, time]);

  const pingFeeds: MonitorPingFeed[] = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.agents.map((ag) => {
      const t = ag.telemetry;
      // Show in-router interface ping (e.g., vlan2000-CMK -> 1.1.1.1) on monitor if configured!
      const activePing = t?.interfacePingResult ?? t?.ping;
      return {
        key: ag.key,
        label: ag.routerConfig?.name ?? ag.nama,
        host: t?.interfacePingResult ? t.interfacePingResult.label : (ag.routerConfig?.host ?? '-'),
        simulated: ag.routerConfig?.simulated ?? true,
        reachable: t?.reachable ?? false,
        cpuPct: t?.cpuLoadPercent ?? 0,
        pppoe: t?.activePppoeCount ?? 0,
        hotspot: t?.activeHotspotCount ?? 0,
        pingAvgMs: activePing?.avgMs ?? null,
        pingLossPct: activePing?.packetLossPercent ?? 0,
        pingStatus: activePing?.status ?? (t?.reachable ? 'ok' : 'down'),
        hasAlert: ag.mendesak.length > 0 || ag.pendingApprovals.length > 0,
      };
    });
  }, [snapshot]);

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
        <Suspense fallback={<div className="ko-loading">Menyiapkan Cafe Datacenter AI NOC…</div>}>
          <OfficeScene
            desks={desks}
            pingFeeds={pingFeeds}
            externalPings={snapshot?.externalPings ?? []}
            topologyLinks={snapshot?.topologyLinks ?? []}
            activeAlerts={snapshot?.spvNoc?.activeAlerts ?? 0}
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
            const isSpv = d.desk.key === 'spv-noc';
            return (
              <Tag
                key={d.desk.key}
                d={d}
                isSpv={isSpv}
                spot={spotKey === d.desk.key}
                idle={d.doing.activity === 'siaga' ? idleAt(d.desk.key, t).spot : null}
                refFn={(el) => (el ? anchors.current.set(d.desk.key, el) : anchors.current.delete(d.desk.key))}
                onOpen={() => {
                  cameraApi.current?.focusAgent(d.desk.key);
                  if (isSpv) {
                    setOpenKey(null);
                    setSpvOpen(true);
                  } else {
                    setSpvOpen(false);
                    setOpenKey(d.desk.key);
                  }
                }}
              />
            );
          })}
          <span className="ko-board-pin" ref={(el) => void (boardAnchor.current = el)}>
            Live Ping Wall
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
                className="noc-fleet-btn noc-spv-btn"
                onClick={() => {
                  cameraApi.current?.focusAgent('spv-noc');
                  setOpenKey(null);
                  setSpvOpen(true);
                }}
                title="Buka 1 AI Supervisor SPV NOC (terhubung ke semua MikroTik & WA Fonnte)"
              >
                👑 <span className="noc-btn-lbl">SPV NOC</span>
                {(snapshot?.spvNoc?.activeAlerts ?? 0) > 0 && (
                  <span className="noc-spv-badge">{snapshot?.spvNoc?.activeAlerts}</span>
                )}
              </button>
              <button
                type="button"
                className="noc-fleet-btn"
                onClick={() => setTopoOpen(true)}
                title="Buka Peta Topologi Kabel Fiber Interaktif (Tarik Kabel Manual)"
              >
                🗺 <span className="noc-btn-lbl">Topologi FO</span>
                {(snapshot?.topologyLinks?.length ?? 0) > 0 && (
                  <span className="noc-btn-short">{snapshot?.topologyLinks?.length}</span>
                )}
              </button>
              <button
                type="button"
                className="noc-fleet-btn"
                onClick={() => setFleetOpen((v) => !v)}
                title="Buka daftar & pengaturan IP semua MikroTik"
              >
                📡 <span className="noc-btn-lbl">{Math.max(0, desks.length - 1)} Router</span>
                <span className="noc-btn-short">{Math.max(0, desks.length - 1)}</span>
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
            {desks
              .filter((d) => d.desk.key !== 'spv-noc')
              .map((d) => {
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
            {snapshot?.externalPings && snapshot.externalPings.length > 0 && (
              <div className="noc-ping-bar">
                {snapshot.externalPings.map((ep) => (
                  <span key={ep.target} className={`noc-ping-chip is-${ep.status}`} title={`${ep.label} (${ep.target}) · Loss ${ep.packetLossPercent}%`}>
                    📡 {ep.target}: <b>{ep.avgMs !== null ? `${ep.avgMs}ms` : 'RTO'}</b>
                  </span>
                ))}
                <button type="button" className="noc-ping-refresh" onClick={() => void pingNow()} title="Test Ping sekarang">
                  🔄
                </button>
              </div>
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

      {/* Interactive Manual Fiber Topology 2D/3D Map Modal */}
      {topoOpen && snapshot && (
        <TopologyMapModal
          snapshot={snapshot}
          onAddLink={addTopologyLink}
          onDeleteLink={deleteTopologyLink}
          onSavePositions={saveTopologyPositions}
          onOpenRouter={(routerId) => {
            setTopoOpen(false);
            cameraApi.current?.focusAgent(routerId);
            setOpenKey(routerId);
          }}
          onClose={() => setTopoOpen(false)}
        />
      )}

      {/* Centralized SPV NOC AI Command Center Modal */}
      {spvOpen && snapshot && (
        <SpvNocCommandModal
          snapshot={snapshot}
          initialPrompt={spvQuickPrompt}
          onConsumeInitialPrompt={() => setSpvQuickPrompt(null)}
          onAsk={askSpvNoc}
          onSendSummaryWa={sendSpvSummaryWa}
          onAddMemoryFact={addAiMemoryFact}
          onDeleteMemoryFact={deleteAiMemoryFact}
          onSearchCustomers={searchCustomers}
          onRunRscBackup={runRscBackupNow}
          onFetchRscPreview={fetchRscPreview}
          onOpenRouter={(routerId) => {
            setSpvOpen(false);
            cameraApi.current?.focusAgent(routerId);
            setOpenKey(routerId);
          }}
          onClose={() => setSpvOpen(false)}
        />
      )}

      {/* Admin Account, Password & Fonnte WA Alert Settings Modal */}
      {accountOpen && (
        <AdminAccountModal
          username={adminUser ?? 'admin'}
          alertSettings={snapshot?.alertSettings}
          onClose={() => setAccountOpen(false)}
          onChangePassword={changePassword}
          onSaveAlerts={updateAlertSettings}
          onTestWa={sendTestWhatsapp}
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
                  ℹ️ Trafik &amp; Hotspot ditarik real-time tiap 3 detik via <b>1x login persistent</b> (tanpa keluar-masuk login) + log <code>/log/print</code> tiap ~9 detik &amp; Syslog UDP <code>5514</code>.
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
                  snapshot.approvals.map((tk) => {
                    const targetAgent = snapshot.agents.find((a) => a.routerId === tk.routerId);
                    const writeReady = Boolean(targetAgent?.routerConfig?.writeExecutionReady);
                    return (
                      <div key={tk.id} className="noc-card">
                        <div className="noc-card-head">
                          <strong>
                            #{tk.id} · {tk.routerName}
                          </strong>
                          <span className={`noc-status-pill is-${tk.status.toLowerCase()}`}>{tk.status}</span>
                        </div>
                        <p style={{ margin: '4px 0', fontSize: '0.84rem' }}>{tk.incidentSummary}</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' }}>
                          <pre className="noc-cmd" style={{ flex: 1, margin: 0 }}>{tk.proposal.previewCommand}</pre>
                          <button
                            type="button"
                            className="noc-btn-sim"
                            style={{ whiteSpace: 'nowrap', marginTop: 0 }}
                            onClick={() => void copyCliCommand(`audit-${tk.id}`, tk.proposal.previewCommand)}
                            title="Salin perintah CLI untuk ditempel di Winbox Terminal"
                          >
                            {copiedCmdId === `audit-${tk.id}` ? '✅ Tersalin!' : '📋 Copy CLI'}
                          </button>
                        </div>
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
                              {busyTicketId === tk.id
                                ? 'Memproses…'
                                : writeReady
                                  ? '⚡ Setujui & Eksekusi via SPV'
                                  : '✅ Tandai Ditangani Manual'}
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
                        )}
                      </div>
                    );
                  })
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
                {openLiveAgent.telemetry.interfacePingResult && (
                  <div>
                    <span>Ping Jalur ({openLiveAgent.telemetry.interfacePingResult.label})</span>
                    <strong
                      style={{
                        color:
                          openLiveAgent.telemetry.interfacePingResult.status === 'ok'
                            ? '#15803d'
                            : openLiveAgent.telemetry.interfacePingResult.status === 'high'
                              ? '#b45309'
                              : '#dc2626',
                      }}
                    >
                      {openLiveAgent.telemetry.interfacePingResult.avgMs !== null
                        ? `${openLiveAgent.telemetry.interfacePingResult.avgMs} ms (max ${openLiveAgent.telemetry.interfacePingResult.maxMs} ms)`
                        : 'RTO / PUTUS'}{' '}
                      · Loss {openLiveAgent.telemetry.interfacePingResult.packetLossPercent}%
                    </strong>
                  </div>
                )}
                {openLiveAgent.telemetry.ping && (
                  <div>
                    <span>Ping Router ({openLiveAgent.telemetry.ping.target})</span>
                    <strong
                      style={{
                        color:
                          openLiveAgent.telemetry.ping.status === 'ok'
                            ? '#15803d'
                            : openLiveAgent.telemetry.ping.status === 'high'
                              ? '#b45309'
                              : '#dc2626',
                      }}
                    >
                      {openLiveAgent.telemetry.ping.avgMs !== null
                        ? `${openLiveAgent.telemetry.ping.avgMs} ms (max ${openLiveAgent.telemetry.ping.maxMs} ms)`
                        : 'RTO / DOWN'}{' '}
                      · Loss {openLiveAgent.telemetry.ping.packetLossPercent}%
                    </strong>
                  </div>
                )}
                <div>
                  <span>PPPoE / Hotspot Aktif</span>
                  <strong>
                    {openLiveAgent.telemetry.activePppoeCount} PPPoE · {openLiveAgent.telemetry.activeHotspotCount ?? 0} HS
                  </strong>
                </div>
                <div>
                  <span>Host Hotspot / DHCP</span>
                  <strong>
                    {openLiveAgent.telemetry.hotspotHostCount ?? 0} host · {openLiveAgent.telemetry.dhcpLeaseCount ?? 0} DHCP
                    {(openLiveAgent.hotspotFailedLoginCount ?? 0) > 0
                      ? ` · ⚠ ${openLiveAgent.hotspotFailedLoginCount} gagal login`
                      : ''}
                  </strong>
                </div>
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

            {/* Centralized SPV NOC Supervisor Link (1 AI Brain controls all routers) */}
            {connected && openLiveAgent && (
              <div className="noc-spv-banner">
                <div>
                  <strong>👑 Diawasi oleh SPV NOC (1 AI Terpusat)</strong>
                  <small>
                    Semua laporan anomali dari agen ini otomatis diteruskan ke SPV NOC &amp; WhatsApp Fonnte.
                  </small>
                </div>
                <button
                  type="button"
                  className="noc-btn-approve"
                  style={{ marginTop: 0, whiteSpace: 'nowrap' }}
                  onClick={() => {
                    const rName = openLiveAgent.routerConfig?.name ?? openLiveAgent.nama;
                    const rId = openLiveAgent.routerId;
                    setOpenKey(null);
                    setSpvQuickPrompt({
                      text: `SPV NOC, laporkan analisa lengkap kondisi router ${rName} sekarang (CPU, PPPoE, Hotspot, gagal login, trafik, dan Ping).`,
                      focusRouterId: rId,
                    });
                    cameraApi.current?.focusAgent('spv-noc');
                    setSpvOpen(true);
                  }}
                >
                  👑 Tanya SPV NOC
                </button>
              </div>
            )}

            {openLiveAgent?.telemetry?.pppoeDrop?.activeIncident && (
              <p className="ko-sheet-urgent">
                🚨 MASS-DISCONNECT PPPOE TERDETEKSI: -{openLiveAgent.telemetry.pppoeDrop.droppedCount} pelanggan terputus (
                {openLiveAgent.telemetry.pppoeDrop.previousPeak} → {openLiveAgent.telemetry.pppoeDrop.currentCount}, -
                {openLiveAgent.telemetry.pppoeDrop.droppedPercent}%)
                {openLiveAgent.telemetry.pppoeDrop.suspectedOltInterfaces.length > 0
                  ? ` · Indikasi OLT/Port: ${openLiveAgent.telemetry.pppoeDrop.suspectedOltInterfaces.join(', ')}`
                  : ''}
              </p>
            )}

            {openLiveAgent?.telemetry?.lastError && (
              <p className="ko-sheet-urgent">🔌 Koneksi API: {openLiveAgent.telemetry.lastError}</p>
            )}

            {openDesk.urgent.length > 0 && (
              <p className="ko-sheet-urgent">⚠ Insiden Aktif: {openDesk.urgent.join(' · ')}</p>
            )}

            {openLiveAgent?.telemetry?.watchedLinks && openLiveAgent.telemetry.watchedLinks.length > 0 && (
              <div className="noc-ifaces">
                <h4>
                  🔗 Link Watchdog Khusus ({openLiveAgent.routerConfig?.dutyLabel ?? 'Link Guard'})
                </h4>
                <div className="noc-iface-grid">
                  {openLiveAgent.telemetry.watchedLinks.map((wl) => (
                    <div
                      key={wl.name}
                      className={`noc-iface-pill ${wl.state === 'down' ? 'is-down' : wl.state === 'drop' ? 'is-drop' : 'is-up'}`}
                    >
                      <strong>
                        {wl.name}{' '}
                        {wl.state === 'down'
                          ? '🔌 DOWN'
                          : wl.state === 'drop'
                            ? `📉 DROP -${wl.dropPercent}%`
                            : '✅ OK'}
                      </strong>
                      <small>
                        Rx {wl.rxMbps} / Tx {wl.txMbps} Mbps · Normal ~{wl.baselineMbps} Mbps
                      </small>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {openLiveAgent?.telemetry?.sfpOptics &&
              openLiveAgent.telemetry.sfpOptics.some((s) => s.health !== 'empty') && (
                <div className="noc-ifaces">
                  <h4>🌅 Redaman Optik Modul SFP (Early-Warning dBm)</h4>
                  <div className="noc-iface-grid">
                    {openLiveAgent.telemetry.sfpOptics
                      .filter((s) => s.health !== 'empty')
                      .map((sfp) => (
                        <div
                          key={sfp.name}
                          className={`noc-iface-pill ${
                            sfp.health === 'critical' ? 'is-down' : sfp.health === 'warning' ? 'is-drop' : 'is-up'
                          }`}
                        >
                          <strong>
                            {sfp.name}{' '}
                            {sfp.health === 'critical'
                              ? '🚨 KRITIS'
                              : sfp.health === 'warning'
                                ? '⚠️ RAWAN'
                                : '✅ OPTIK OK'}
                          </strong>
                          <small>
                            RX <b>{sfp.rxPowerDbm !== null ? `${sfp.rxPowerDbm} dBm` : 'LOS'}</b> · TX{' '}
                            {sfp.txPowerDbm !== null ? `${sfp.txPowerDbm} dBm` : '-'}
                            {sfp.temperatureC !== null ? ` · ${sfp.temperatureC}°C` : ''}
                            {sfp.vendor ? ` · ${sfp.vendor}` : ''}
                          </small>
                        </div>
                      ))}
                  </div>
                </div>
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
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <h4 style={{ margin: 0 }}>🔒 Menunggu Persetujuan / Diagnostik (Human-in-the-Loop)</h4>
                  <span
                    style={{
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      padding: '3px 8px',
                      borderRadius: '999px',
                      background: openLiveAgent.routerConfig?.writeExecutionReady ? '#dcfce7' : '#f1f5f9',
                      color: openLiveAgent.routerConfig?.writeExecutionReady ? '#166534' : '#475569',
                    }}
                  >
                    {openLiveAgent.routerConfig?.writeExecutionReady
                      ? '⚡ SPV Write Aktif'
                      : '🔒 Mode Read-Only (Manual Winbox)'}
                  </span>
                </div>
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' }}>
                      <pre className="noc-cmd" style={{ flex: 1, margin: 0 }}>{tk.proposal.previewCommand}</pre>
                      <button
                        type="button"
                        className="noc-btn-sim"
                        style={{ whiteSpace: 'nowrap', marginTop: 0 }}
                        onClick={() => void copyCliCommand(tk.id, tk.proposal.previewCommand)}
                        title="Salin perintah CLI untuk ditempel ke Winbox Terminal"
                      >
                        {copiedCmdId === tk.id ? '✅ Tersalin!' : '📋 Copy CLI'}
                      </button>
                    </div>
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
                        {busyTicketId === tk.id
                          ? 'Memproses…'
                          : openLiveAgent.routerConfig?.writeExecutionReady
                            ? '⚡ Setujui & Eksekusi via SPV'
                            : '✅ Tandai Ditangani Manual'}
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
  alertSettings,
  onClose,
  onChangePassword,
  onSaveAlerts,
  onTestWa,
  onLogout,
}: {
  username: string;
  alertSettings?: LiveAlertSettings;
  onClose: () => void;
  onChangePassword: (cur: string, nextPass: string, nextUser?: string) => Promise<void>;
  onSaveAlerts: (patch: Partial<Omit<LiveAlertSettings, 'waTokenConfigured'>>) => Promise<LiveAlertSettings | undefined>;
  onTestWa: (target?: string) => Promise<string>;
  onLogout: () => Promise<void>;
}) {
  const [tab, setTab] = useState<'wa' | 'account'>('wa');
  const [newUser, setNewUser] = useState(username);
  const [curPass, setCurPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [waEnabled, setWaEnabled] = useState(alertSettings?.waEnabled ?? true);
  const [waTarget, setWaTarget] = useState(alertSettings?.waTarget ?? '');
  const [dailyReportEnabled, setDailyReportEnabled] = useState(alertSettings?.dailyReportEnabled ?? true);
  const [dailyReportHour, setDailyReportHour] = useState(String(alertSettings?.dailyReportHour ?? 8));
  const [pingWarnMs, setPingWarnMs] = useState(String(alertSettings?.pingWarnMs ?? 50));
  const [pingCritMs, setPingCritMs] = useState(String(alertSettings?.pingCritMs ?? 100));
  const [extPingCritMs, setExtPingCritMs] = useState(String(alertSettings?.extPingCritMs ?? 150));
  const [pingConfirmCount, setPingConfirmCount] = useState(String(alertSettings?.pingConfirmCount ?? 4));
  const [cooldownMin, setCooldownMin] = useState(String(Math.round((alertSettings?.alertCooldownSec ?? 3600) / 60)));
  const [sfpRxCritDbm, setSfpRxCritDbm] = useState(String(alertSettings?.sfpRxCritDbm ?? -24));
  const [pppoeMassDropCount, setPppoeMassDropCount] = useState(String(alertSettings?.pppoeMassDropCount ?? 15));
  const [waMsg, setWaMsg] = useState<{ ok: boolean; text: string } | null>(null);

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

  const handleSaveWa = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setWaMsg(null);
    try {
      await onSaveAlerts({
        waEnabled,
        waTarget: waTarget.trim(),
        dailyReportEnabled,
        dailyReportHour: Math.max(0, Math.min(23, Number(dailyReportHour) || 8)),
        pingWarnMs: Math.max(5, Number(pingWarnMs) || 50),
        pingCritMs: Math.max(10, Number(pingCritMs) || 100),
        extPingCritMs: Math.max(20, Number(extPingCritMs) || 150),
        pingConfirmCount: Math.max(1, Math.min(10, Number(pingConfirmCount) || 4)),
        alertCooldownSec: Math.max(60, (Number(cooldownMin) || 60) * 60),
        sfpRxCritDbm: Math.max(-40, Math.min(-10, Number(sfpRxCritDbm) || -24)),
        pppoeMassDropCount: Math.max(5, Math.min(500, Number(pppoeMassDropCount) || 15)),
      });
      setWaMsg({ ok: true, text: 'Filter anti-spam WA & Laporan Harian berhasil disimpan!' });
    } catch (err) {
      setWaMsg({ ok: false, text: err instanceof Error ? err.message : 'Gagal menyimpan pengaturan WA' });
    } finally {
      setBusy(false);
    }
  };

  const handleTestWa = async () => {
    setBusy(true);
    setWaMsg(null);
    try {
      const detail = await onTestWa(waTarget.trim() || undefined);
      setWaMsg({ ok: true, text: `✅ ${detail}` });
    } catch (err) {
      setWaMsg({ ok: false, text: err instanceof Error ? err.message : 'Tes WA gagal' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ko-sheet" role="dialog" aria-label="Pengaturan Admin dan Alert WA" onClick={onClose}>
      <div className="ko-sheet-in" style={{ width: 'min(500px, 95vw)' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 8px' }}>⚙️ Pengaturan NOC &amp; Notifikasi WhatsApp</h3>
        <div className="noc-tabs">
          <button type="button" className={tab === 'wa' ? 'is-active' : ''} onClick={() => setTab('wa')}>
            📲 WA Fonnte &amp; Ping
          </button>
          <button type="button" className={tab === 'account' ? 'is-active' : ''} onClick={() => setTab('account')}>
            🔐 Akun Admin ({username})
          </button>
        </div>

        {tab === 'wa' ? (
          <form onSubmit={(e) => void handleSaveWa(e)} className="noc-form-grid">
            <div style={{ gridColumn: '1 / -1', fontSize: '0.78rem' }}>
              Status Token Fonnte:{' '}
              <b style={{ color: alertSettings?.waTokenConfigured ? '#15803d' : '#dc2626' }}>
                {alertSettings?.waTokenConfigured ? '✅ Aktif (Terpasang di Server)' : '⚠ Belum diset di .env'}
              </b>
            </div>
            <label style={{ gridColumn: '1 / -1' }}>
              <span>Nomor WA Tujuan / ID Grup WA (Fonnte)</span>
              <input
                value={waTarget}
                onChange={(e) => setWaTarget(e.target.value)}
                placeholder="Contoh: 0812xxxxxxxx"
              />
            </label>
            <label>
              <span>Ping Kritis Router (ms)</span>
              <input type="number" min={10} max={5000} value={pingCritMs} onChange={(e) => setPingCritMs(e.target.value)} />
            </label>
            <label>
              <span>Ping Kritis Internet (ms)</span>
              <input type="number" min={20} max={5000} value={extPingCritMs} onChange={(e) => setExtPingCritMs(e.target.value)} />
            </label>
            <label>
              <span>Konfirmasi Berturut (x cek)</span>
              <input type="number" min={1} max={10} value={pingConfirmCount} onChange={(e) => setPingConfirmCount(e.target.value)} />
            </label>
            <label>
              <span>Jeda Anti-Spam (menit)</span>
              <input type="number" min={1} max={1440} value={cooldownMin} onChange={(e) => setCooldownMin(e.target.value)} />
            </label>
            <label>
              <span>Jam Laporan Harian (0–23)</span>
              <input type="number" min={0} max={23} value={dailyReportHour} onChange={(e) => setDailyReportHour(e.target.value)} />
            </label>
            <label>
              <span>Ping Waspada Dashboard (ms)</span>
              <input type="number" min={5} max={2000} value={pingWarnMs} onChange={(e) => setPingWarnMs(e.target.value)} />
            </label>
            <label>
              <span>Batas Kritis SFP (dBm)</span>
              <input type="number" step="0.5" min={-40} max={-10} value={sfpRxCritDbm} onChange={(e) => setSfpRxCritDbm(e.target.value)} />
            </label>
            <label>
              <span>Ambang Mass-Drop PPPoE (user)</span>
              <input type="number" min={5} max={500} value={pppoeMassDropCount} onChange={(e) => setPppoeMassDropCount(e.target.value)} />
            </label>
            <div className="noc-check-row" style={{ gridColumn: '1 / -1', margin: '2px 0' }}>
              <label>
                <input type="checkbox" checked={dailyReportEnabled} onChange={(e) => setDailyReportEnabled(e.target.checked)} />
                <span>Kirim Laporan Harian 1x/hari (jam {String(Number(dailyReportHour) || 8).padStart(2, '0')}:00)</span>
              </label>
              <label>
                <input type="checkbox" checked={waEnabled} onChange={(e) => setWaEnabled(e.target.checked)} />
                <span>Mode Anti-Spam: HANYA kirim alert segera jika KRITIS terkonfirmasi ({pingConfirmCount}x berturut)</span>
              </label>
            </div>
            {waMsg && (
              <p className={`noc-feedback ${waMsg.ok ? 'is-ok' : 'is-err'}`} style={{ gridColumn: '1 / -1' }}>
                {waMsg.text}
              </p>
            )}
            <div className="noc-btn-row" style={{ gridColumn: '1 / -1' }}>
              <button type="submit" className="noc-btn-approve" disabled={busy}>
                {busy ? 'Menyimpan…' : '💾 Simpan Alert WA'}
              </button>
              <button type="button" className="noc-btn-sim" disabled={busy} onClick={() => void handleTestWa()}>
                📲 Tes Kirim WA
              </button>
              <button type="button" onClick={onClose} style={{ marginLeft: 'auto' }}>
                Tutup
              </button>
            </div>
          </form>
        ) : (
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
        )}
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
  const [routerName, setRouterName] = useState(cfg.name);
  const [agentName, setAgentName] = useState(cfg.agentName ?? agent.nama);
  const [dutyRole, setDutyRole] = useState<LiveAgentDutyRole>(cfg.dutyRole ?? 'branch_dist');
  const [dutyLabel, setDutyLabel] = useState(cfg.dutyLabel ?? '');
  const [watchedCsv, setWatchedCsv] = useState((cfg.watchedInterfaces ?? []).join(', '));
  const [dropPct, setDropPct] = useState(String(cfg.trafficDropThresholdPct ?? 55));
  const [minMbps, setMinMbps] = useState(String(cfg.minTrafficMbps ?? 0));
  const [ifPingIface, setIfPingIface] = useState(cfg.interfacePing?.interfaceName ?? '');
  const [ifPingTarget, setIfPingTarget] = useState(cfg.interfacePing?.target ?? '1.1.1.1');
  const [customPrompt, setCustomPrompt] = useState(cfg.customPrompt ?? '');
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

  const buildPatch = (clearPassword = false): RouterConfigPatch => {
    const watchedList = watchedCsv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const ifPingClean =
      ifPingIface.trim() && ifPingTarget.trim()
        ? {
            interfaceName: ifPingIface.trim(),
            target: ifPingTarget.trim(),
            warnMs: cfg.interfacePing?.warnMs ?? 80,
            critMs: cfg.interfacePing?.critMs ?? 140,
          }
        : null;
    return {
      name: routerName.trim() || cfg.name,
      agentName: agentName.trim() || cfg.agentName || agent.nama,
      dutyRole,
      dutyLabel: dutyLabel.trim(),
      watchedInterfaces: watchedList,
      trafficDropThresholdPct: Math.max(10, Math.min(95, Number(dropPct) || 55)),
      minTrafficMbps: Math.max(0, Number(minMbps) || 0),
      interfacePing: ifPingClean,
      customPrompt: customPrompt.trim(),
      host: host.trim(),
      port: parsedPort,
      useTls,
      routerOsVersion: rosVer,
      readUsername: readUsername.trim() || 'noc_readonly',
      ...(clearPassword ? { clearReadPassword: true } : readPassword ? { readPassword } : {}),
      simulated,
    };
  };

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
        <span>⚙️ Edit Nama Agen, Role Link Watchdog, Prompt SOP &amp; Koneksi</span>
        <span>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="noc-config-body">
          <div className="noc-form-grid">
            <label>
              <span>Nama Agen (Tampil di 3D)</span>
              <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Contoh: Bima · Master Backbone" />
            </label>
            <label>
              <span>Nama Router MikroTik</span>
              <input value={routerName} onChange={(e) => setRouterName(e.target.value)} placeholder="Contoh: CRS-Backbone-01" />
            </label>
            <label>
              <span>Role Tugas Khusus Agen</span>
              <select value={dutyRole} onChange={(e) => setDutyRole(e.target.value as LiveAgentDutyRole)}>
                <option value="backbone_master">🛡 Master Backbone &amp; Suplai CRS</option>
                <option value="link_guard">🔗 Link &amp; Ethernet Backbone Guard</option>
                <option value="core_vlan_watchdog">⚡ Core VLAN Watchdog (vlan2000-CMK)</option>
                <option value="bras_gateway">🌐 BRAS Pusat (PPPoE, Hotspot &amp; OLT)</option>
                <option value="branch_dist">📡 Distribusi Cabang (RB750)</option>
              </select>
            </label>
            <label>
              <span>Label Tugas Singkat</span>
              <input value={dutyLabel} onChange={(e) => setDutyLabel(e.target.value)} placeholder="Contoh: Core VLAN Watchdog (vlan2000-CMK)" />
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              <span>Interface Khusus Dipantau (pisahkan koma — cek Link Down &amp; Trafik Drop)</span>
              <input
                value={watchedCsv}
                onChange={(e) => setWatchedCsv(e.target.value)}
                placeholder="Contoh: vlan2000-CMK, ether1-METRO CMK"
              />
            </label>
            <label>
              <span>Ambang Trafik Drop (%)</span>
              <input value={dropPct} onChange={(e) => setDropPct(e.target.value)} type="number" min={10} max={95} />
            </label>
            <label>
              <span>Batas Min Trafik Normal (Mbps, 0=auto)</span>
              <input value={minMbps} onChange={(e) => setMinMbps(e.target.value)} type="number" min={0} max={10000} />
            </label>
            <label>
              <span>Ping via Interface (Dari Dalam Router)</span>
              <input
                value={ifPingIface}
                onChange={(e) => setIfPingIface(e.target.value)}
                placeholder="Contoh: vlan2000-CMK (kosong = nonaktif)"
              />
            </label>
            <label>
              <span>Target Ping Internet via Interface</span>
              <input
                value={ifPingTarget}
                onChange={(e) => setIfPingTarget(e.target.value)}
                placeholder="Contoh: 1.1.1.1"
              />
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              <span>Instruksi / Prompt SOP Khusus untuk Agen Ini (Dibaca SPV NOC)</span>
              <textarea
                rows={2}
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="Contoh: Prioritaskan vlan2000-CMK penyuplai CCR Mongkonai. Jika drop atau ping naik, segera eskalasi ke SPV NOC."
                style={{
                  padding: '6px 8px',
                  border: '1px solid #d4cbe6',
                  borderRadius: '8px',
                  font: 'inherit',
                  fontSize: '0.8rem',
                  resize: 'vertical',
                }}
              />
            </label>
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

function SpvNocCommandModal({
  snapshot,
  initialPrompt,
  onConsumeInitialPrompt,
  onAsk,
  onSendSummaryWa,
  onAddMemoryFact,
  onDeleteMemoryFact,
  onSearchCustomers,
  onRunRscBackup,
  onFetchRscPreview,
  onOpenRouter,
  onClose,
}: {
  snapshot: LiveNocSnapshot;
  initialPrompt: { text: string; focusRouterId?: string } | null;
  onConsumeInitialPrompt: () => void;
  onAsk: (question: string, focusRouterId?: string) => Promise<{ reply: string; source: string }>;
  onSendSummaryWa: (target?: string) => Promise<string>;
  onAddMemoryFact: (text: string, topic?: string) => Promise<void>;
  onDeleteMemoryFact: (factId: string) => Promise<void>;
  onSearchCustomers: (query: string) => Promise<LiveCustomerLookupResult>;
  onRunRscBackup: () => Promise<LiveRscBackupSummary>;
  onFetchRscPreview: (fileName: string) => Promise<string>;
  onOpenRouter: (routerId: string) => void;
  onClose: () => void;
}) {
  const spv = snapshot.spvNoc;
  const memory = snapshot.aiMemory;
  const [tab, setTab] = useState<'chat' | 'customers' | 'nms' | 'rsc' | 'reports' | 'memory'>('chat');
  const [question, setQuestion] = useState('');
  const [newFactText, setNewFactText] = useState('');
  const [newFactTopic, setNewFactTopic] = useState('SOP & Topologi');
  const [busy, setBusy] = useState(false);
  const [waBusy, setWaBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const sendPrompt = async (text: string, focusRouterId?: string) => {
    const clean = text.trim();
    if (!clean || busy) return;
    setBusy(true);
    setFeedback(null);
    setQuestion('');
    setTab('chat');
    try {
      await onAsk(clean, focusRouterId);
    } catch (e) {
      setFeedback({ ok: false, text: e instanceof Error ? e.message : 'Gagal menghubungi SPV NOC' });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initialPrompt) {
      onConsumeInitialPrompt();
      void sendPrompt(initialPrompt.text, initialPrompt.focusRouterId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  const handleSendWaSummary = async () => {
    setWaBusy(true);
    setFeedback(null);
    try {
      const detail = await onSendSummaryWa();
      setFeedback({ ok: true, text: `📲 Rekap SPV NOC terkirim ke WA (${snapshot.alertSettings?.waTarget || 'Fonnte'}): ${detail}` });
    } catch (e) {
      setFeedback({ ok: false, text: e instanceof Error ? e.message : 'Gagal mengirim rekap WA' });
    } finally {
      setWaBusy(false);
    }
  };

  const totalPppoe = snapshot.agents.reduce((s, a) => s + (a.telemetry?.activePppoeCount ?? 0), 0);
  const totalHotspot = snapshot.agents.reduce((s, a) => s + (a.telemetry?.activeHotspotCount ?? 0), 0);
  const onlineCount = snapshot.agents.filter((a) => a.telemetry?.reachable).length;
  const messages = spv?.messages ?? [];
  const reports = spv?.reports ?? [];

  return (
    <div className="ko-sheet" role="dialog" aria-label="SPV NOC AI Supervisor Command Center" onClick={onClose}>
      <div
        className="ko-sheet-in"
        style={{ width: 'min(740px, 96vw)', maxHeight: '88vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ margin: 0 }}>👑 SPV NOC — AI Supervisor Terpusat</h3>
            <small style={{ color: '#475569' }}>
              {spv?.modelLabel ?? 'Gemini Cloud AI'} · Mengontrol {snapshot.agents.length} Router &amp; Lapor WA ke{' '}
              <b>{snapshot.alertSettings?.waTarget || '(belum diset)'}</b>
            </small>
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button type="button" className="noc-btn-approve" disabled={waBusy} onClick={() => void handleSendWaSummary()}>
              {waBusy ? 'Mengirim…' : '📲 Kirim Rekap ke WA'}
            </button>
            <button type="button" onClick={onClose} style={{ marginTop: 0 }}>
              Tutup
            </button>
          </div>
        </div>

        <div className="noc-metrics-grid" style={{ marginTop: '10px' }}>
          <div>
            <span>Fleet Router Online</span>
            <strong>
              {onlineCount}/{snapshot.agents.length} ({spv?.liveRouters ?? 0} LIVE)
            </strong>
          </div>
          <div>
            <span>Total Pelanggan Aktif</span>
            <strong>
              {totalPppoe} PPPoE · {totalHotspot} Hotspot
            </strong>
          </div>
          <div>
            <span>Ping Internet &amp; Alert</span>
            <strong>
              {(snapshot.externalPings ?? [])
                .map((p) => `${p.target}: ${p.avgMs !== null ? `${p.avgMs}ms` : 'RTO'}`)
                .join(' · ') || 'Menunggu ping…'}
            </strong>
          </div>
        </div>

        <div className="noc-tabs" style={{ flexWrap: 'wrap' }}>
          <button type="button" className={tab === 'chat' ? 'is-active' : ''} onClick={() => setTab('chat')}>
            🤖 Chat AI ({messages.length})
          </button>
          <button type="button" className={tab === 'customers' ? 'is-active' : ''} onClick={() => setTab('customers')}>
            🔍 Cek Pelanggan
          </button>
          <button type="button" className={tab === 'nms' ? 'is-active' : ''} onClick={() => setTab('nms')}>
            📡 OLT &amp; Modem
          </button>
          <button type="button" className={tab === 'rsc' ? 'is-active' : ''} onClick={() => setTab('rsc')}>
            💾 Backup .rsc ({snapshot.rscBackups?.entries.length ?? 0})
          </button>
          <button type="button" className={tab === 'reports' ? 'is-active' : ''} onClick={() => setTab('reports')}>
            📥 Laporan ({reports.length})
          </button>
          <button type="button" className={tab === 'memory' ? 'is-active' : ''} onClick={() => setTab('memory')}>
            🧠 Memori AI ({memory?.learnedFacts.length ?? 0})
          </button>
        </div>

        {tab === 'customers' ? (
          <CustomerLookupPanel onSearch={onSearchCustomers} onOpenRouter={onOpenRouter} />
        ) : tab === 'nms' ? (
          <NmsOltPanel />
        ) : tab === 'rsc' ? (
          <RscBackupVaultPanel
            rscBackups={snapshot.rscBackups}
            onRunBackup={onRunRscBackup}
            onFetchPreview={onFetchRscPreview}
          />
        ) : tab === 'chat' ? (
          <div className="noc-ai-body" style={{ padding: 0 }}>
            <div className="noc-ai-chips">
              <button
                type="button"
                disabled={busy}
                onClick={() => void sendPrompt('Berikan laporan ringkas kondisi semua router MikroTik yang live sekarang')}
              >
                📊 Laporan Semua Router
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void sendPrompt('Berapa total user hotspot & PPPoE di semua router dan apakah ada yang gagal login?')}
              >
                📶 Hotspot &amp; Gagal Login
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void sendPrompt('Cek ping semua router live dan internet 1.1.1.1 / 8.8.8.8, apakah ada yang membengkak?')}
              >
                📡 Cek Semua Ping
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void sendPrompt(
                    'Cek redaman optik SFP (dBm) di semua CRS Backbone serta status link dan ping VLAN utama sekarang.',
                  )
                }
              >
                🌅 Redaman SFP Semua CRS
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void sendPrompt(
                    'Analisa pola pemakaian bandwidth dan koneksi pelanggan jam ini dibandingkan rata-rata normal beserta kesimpulan SPV AI.',
                  )
                }
              >
                📈 Pola Bandwidth &amp; Kesimpulan AI
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void sendPrompt('Apakah ada anomali, CPU tinggi, atau RADIUS timeout dari laporan agen NOC?')}
              >
                🚨 Cek Semua Anomali
              </button>
            </div>

            {messages.length > 0 && (
              <div className="noc-ai-chat" style={{ maxHeight: '300px' }}>
                {messages.slice(-10).map((m) => (
                  <div key={m.id} className={`noc-ai-msg is-${m.role}`}>
                    <div className="noc-ai-msg-meta">
                      <b>{m.source || (m.role === 'user' ? 'Boss / Admin' : 'SPV NOC')}</b>
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
                placeholder='Tanya SPV NOC atau ajari langsung (ketik "Ingat ya: ...")'
                disabled={busy}
              />
              <button type="submit" className="noc-btn-approve" disabled={busy || !question.trim()}>
                {busy ? 'Menganalisa…' : 'Kirim'}
              </button>
            </form>
          </div>
        ) : tab === 'memory' ? (
          <div className="noc-spv-reports">
            <p style={{ margin: '0 0 6px', fontSize: '0.8rem', color: '#475569' }}>
              🧠 Semua percakapan Anda (Web &amp; Telegram) tersimpan otomatis (<b>{memory?.totalConversations ?? 0} chat</b>{' '}
              diarsipkan) untuk melatih <b>Gemini Cloud AI</b> &amp; <b>AI Lokal</b>. Anda juga bisa langsung mengajari SPV NOC
              lewat form di bawah atau mengetik <code>Ingat ya: ...</code> di chat / Telegram!
            </p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newFactText.trim()) return;
                setBusy(true);
                setFeedback(null);
                try {
                  await onAddMemoryFact(newFactText.trim(), newFactTopic.trim() || 'SOP & Topologi');
                  setNewFactText('');
                  setFeedback({ ok: true, text: '🧠 Pengetahuan baru tersimpan! AI Lokal & Gemini kini mengingatnya.' });
                } catch (err) {
                  setFeedback({ ok: false, text: err instanceof Error ? err.message : 'Gagal menyimpan memori' });
                } finally {
                  setBusy(false);
                }
              }}
              className="noc-form-grid"
              style={{ marginBottom: '8px' }}
            >
              <label>
                <span>Kategori / Topik</span>
                <input value={newFactTopic} onChange={(e) => setNewFactTopic(e.target.value)} placeholder="SOP & Topologi" />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                <span>Ajari SPV NOC Fakta / SOP / Rute Baru</span>
                <input
                  value={newFactText}
                  onChange={(e) => setNewFactText(e.target.value)}
                  placeholder="Contoh: OLT Global 01 melayani area Utara; kalau putus cek tiang FO simpang Mongkonai."
                  required
                />
              </label>
              <div style={{ gridColumn: '1 / -1' }}>
                <button type="submit" className="noc-btn-approve" disabled={busy || !newFactText.trim()}>
                  {busy ? 'Menyimpan…' : '🧠 Simpan ke Memori AI'}
                </button>
              </div>
            </form>
            {!memory || memory.learnedFacts.length === 0 ? (
              <p style={{ fontSize: '0.82rem', color: '#64748b' }}>
                Belum ada catatan manual. Coba tambahkan fakta topologi/SOP di atas atau ketik &ldquo;Ingat ya: ...&rdquo; di chat!
              </p>
            ) : (
              memory.learnedFacts.map((f) => (
                <div key={f.id} className="noc-spv-report-item">
                  <div className="noc-card-head">
                    <strong>
                      🧠 [{f.topic}] <small>oleh {f.source}</small>
                    </strong>
                    <button
                      type="button"
                      className="noc-link-btn"
                      style={{ color: '#dc2626' }}
                      onClick={() => void onDeleteMemoryFact(f.id)}
                    >
                      Hapus
                    </button>
                  </div>
                  <p style={{ margin: '4px 0 0', fontSize: '0.82rem' }}>{f.text}</p>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="noc-spv-reports">
            {reports.length === 0 ? (
              <p style={{ fontSize: '0.84rem', color: '#475569' }}>
                ✅ Belum ada laporan anomali yang masuk ke SPV NOC. Semua agen NOC terus memantau &amp; akan langsung melapor
                jika Ping membengkak, RADIUS timeout, atau router bermasalah.
              </p>
            ) : (
              reports.map((rep) => (
                <div key={rep.id} className={`noc-spv-report-item is-${rep.severity}`}>
                  <div className="noc-card-head">
                    <strong>
                      [{rep.category.toUpperCase()}] {rep.routerName} · <small>{rep.agentName}</small>
                    </strong>
                    <span>
                      {rep.sentToWa && <span className="noc-status-pill is-executed">✅ WA Fonnte</span>}{' '}
                      <small>{new Date(rep.timestamp).toLocaleTimeString('id-ID')}</small>
                    </span>
                  </div>
                  <p style={{ margin: '4px 0 0', fontSize: '0.82rem' }}>{rep.message}</p>
                  {rep.routerId !== 'spv-noc' && (
                    <button
                      type="button"
                      className="noc-link-btn"
                      style={{ marginTop: '4px' }}
                      onClick={() => onOpenRouter(rep.routerId)}
                    >
                      Buka detail {rep.routerName} →
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {feedback && <p className={`noc-feedback ${feedback.ok ? 'is-ok' : 'is-err'}`}>{feedback.text}</p>}
      </div>
    </div>
  );
}

function Tag({
  d,
  isSpv,
  spot,
  idle,
  refFn,
  onOpen,
}: {
  d: DeskState;
  isSpv: boolean;
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
        : isSpv
          ? '👑AI'
          : null;
  return (
    <div
      className={`ko-tag ${isSpv ? 'is-spv is-ai-linked' : ''}`}
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
