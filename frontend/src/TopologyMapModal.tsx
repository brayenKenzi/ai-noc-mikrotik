import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  LiveFiberLinkType,
  LiveNocSnapshot,
  LiveOfficeAgent,
  LiveTopologyLink,
  LiveTopologyNodePosition,
} from './nocLive';

const MAP_W = 980;
const MAP_H = 560;
const NODE_W = 166;
const NODE_H = 68;

const DEFAULT_2D_SLOTS: Record<string, readonly [number, number]> = {
  'core-mongkonai': [135, 250],
  'crs-backbone-01': [380, 120],
  'crs-backbone-02': [380, 290],
  'crs-backbone-03': [380, 445],
  'crs-backbone-04': [135, 445],
  'ccr-momonet-pusat': [670, 115],
  'rb750-qairen': [720, 260],
  'rb750-dn-bangomolunow': [720, 390],
  'rb750-dn-lolan': [720, 495],
};

function defaultPosFor(agent: LiveOfficeAgent, idx: number): { x: number; y: number } {
  const preset = DEFAULT_2D_SLOTS[agent.routerId];
  if (preset) return { x: preset[0], y: preset[1] };
  const col = idx % 3;
  const row = Math.floor(idx / 3);
  return { x: 160 + col * 290, y: 110 + row * 145 };
}

function linkColor(link: LiveTopologyLink): string {
  if (link.status === 'down') return '#ef4444';
  if (link.status === 'degraded') return '#f59e0b';
  if (link.color) return link.color;
  if (link.fiberType === 'vlan') return '#fbbf24';
  if (link.fiberType === 'olt') return '#22c55e';
  if (link.fiberType === 'backup') return '#a855f7';
  return '#38bdf8';
}

export default function TopologyMapModal({
  snapshot,
  onAddLink,
  onDeleteLink,
  onSavePositions,
  onOpenRouter,
  onClose,
}: {
  snapshot: LiveNocSnapshot;
  onAddLink: (payload: {
    fromRouterId: string;
    fromInterface: string;
    toRouterId: string;
    toInterface: string;
    label?: string;
    fiberType?: LiveFiberLinkType;
  }) => Promise<void>;
  onDeleteLink: (linkId: string) => Promise<void>;
  onSavePositions: (positions: LiveTopologyNodePosition[]) => Promise<void>;
  onOpenRouter: (routerId: string) => void;
  onClose: () => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const agents = snapshot.agents;
  const links = snapshot.topologyLinks ?? [];

  // Initialize node positions from saved backend coordinates or smart defaults
  const [posMap, setPosMap] = useState<Record<string, { x: number; y: number }>>(() => {
    const saved = new Map((snapshot.topologyPositions ?? []).map((p) => [p.routerId, p]));
    const init: Record<string, { x: number; y: number }> = {};
    agents.forEach((ag, idx) => {
      const s = saved.get(ag.routerId);
      init[ag.routerId] = s ? { x: s.x, y: s.y } : defaultPosFor(ag, idx);
    });
    return init;
  });

  // Sync newly added routers without overwriting active drags
  useEffect(() => {
    setPosMap((prev) => {
      let changed = false;
      const next = { ...prev };
      const saved = new Map((snapshot.topologyPositions ?? []).map((p) => [p.routerId, p]));
      agents.forEach((ag, idx) => {
        if (!next[ag.routerId]) {
          const s = saved.get(ag.routerId);
          next[ag.routerId] = s ? { x: s.x, y: s.y } : defaultPosFor(ag, idx);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [agents, snapshot.topologyPositions]);

  // Dragging state for flexible node arrangement
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragOffset = useRef({ dx: 0, dy: 0 });
  const dragMoved = useRef(false);

  // Manual cable drawing state (click Node A -> flexible live preview curve -> click Node B!)
  const [connectMode, setConnectMode] = useState(false);
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [cursorPt, setCursorPt] = useState<{ x: number; y: number } | null>(null);

  const [fromIface, setFromIface] = useState('');
  const [toIface, setToIface] = useState('');
  const [cableLabel, setCableLabel] = useState('');
  const [fiberType, setFiberType] = useState<LiveFiberLinkType>('backbone');
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const fromAgent = fromId ? agents.find((a) => a.routerId === fromId) ?? null : null;
  const toAgent = toId ? agents.find((a) => a.routerId === toId) ?? null : null;
  const selectedLink = selectedLinkId ? links.find((l) => l.id === selectedLinkId) ?? null : null;

  const toSvgCoords = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / Math.max(1, rect.width)) * MAP_W,
      y: ((clientY - rect.top) / Math.max(1, rect.height)) * MAP_H,
    };
  };

  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const pt = toSvgCoords(e.clientX, e.clientY);
    if (connectMode && fromId && !toId) {
      setCursorPt(pt);
    }
    if (draggingId) {
      dragMoved.current = true;
      const nx = Math.max(NODE_W / 2 + 12, Math.min(MAP_W - NODE_W / 2 - 12, pt.x - dragOffset.current.dx));
      const ny = Math.max(NODE_H / 2 + 12, Math.min(MAP_H - NODE_H / 2 - 12, pt.y - dragOffset.current.dy));
      setPosMap((prev) => ({ ...prev, [draggingId]: { x: nx, y: ny } }));
    }
  };

  const handleSvgPointerUp = () => {
    if (draggingId) {
      const moved = dragMoved.current;
      setDraggingId(null);
      if (moved) {
        const list: LiveTopologyNodePosition[] = Object.entries(posMap).map(([routerId, p]) => ({
          routerId,
          x: p.x,
          y: p.y,
        }));
        void onSavePositions(list);
      }
    }
  };

  const handleNodePointerDown = (e: React.PointerEvent, routerId: string) => {
    e.stopPropagation();
    if (connectMode) {
      if (!fromId) {
        setFromId(routerId);
        setToId(null);
        setFromIface('');
        setToIface('');
        setCableLabel('');
        setSelectedLinkId(null);
        setFeedback({ ok: true, text: 'Router asal dipilih! Sekarang klik router tujuan untuk menyambung kabel FO.' });
      } else if (fromId === routerId) {
        setFromId(null);
        setToId(null);
        setCursorPt(null);
      } else {
        setToId(routerId);
        setCursorPt(null);
        setFeedback(null);
      }
      return;
    }

    const pt = toSvgCoords(e.clientX, e.clientY);
    const cur = posMap[routerId] ?? { x: 200, y: 200 };
    dragOffset.current = { dx: pt.x - cur.x, dy: pt.y - cur.y };
    dragMoved.current = false;
    setDraggingId(routerId);
  };

  const handleCreateCable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fromId || !toId) return;
    setBusy(true);
    setFeedback(null);
    try {
      await onAddLink({
        fromRouterId: fromId,
        fromInterface: fromIface.trim(),
        toRouterId: toId,
        toInterface: toIface.trim(),
        label: cableLabel.trim() || undefined,
        fiberType,
      });
      setFromId(null);
      setToId(null);
      setFromIface('');
      setToIface('');
      setCableLabel('');
      setFeedback({ ok: true, text: '✅ Kabel Fiber berhasil dipasang (aktif di Peta 2D, Ruang 3D & memori SPV NOC)!' });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : 'Gagal memasang kabel' });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteSelected = async () => {
    if (!selectedLink) return;
    setBusy(true);
    try {
      await onDeleteLink(selectedLink.id);
      setSelectedLinkId(null);
      setFeedback({ ok: true, text: 'Kabel fiber berhasil dilepas/dihapus.' });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : 'Gagal menghapus kabel' });
    } finally {
      setBusy(false);
    }
  };

  // Compute graceful Bezier curve geometry for every cable (auto-offsets parallel cables so they never overlap)
  const renderedLinks = useMemo(() => {
    const pairCounts = new Map<string, number>();
    return links.map((link) => {
      const pairKey = [link.fromRouterId, link.toRouterId].sort().join('::');
      const idx = pairCounts.get(pairKey) ?? 0;
      pairCounts.set(pairKey, idx + 1);

      const p1 = posMap[link.fromRouterId] ?? { x: 160, y: 160 };
      const p2 = posMap[link.toRouterId] ?? { x: 520, y: 260 };
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.hypot(dx, dy) || 1;
      // Normal perpendicular vector for smooth flexible curve bend
      const nx = -dy / dist;
      const ny = dx / dist;
      const bendSign = idx % 2 === 0 ? 1 : -1;
      const bendAmt = (idx === 0 ? 28 : 54 * Math.ceil(idx / 2)) * bendSign;
      const cx = (p1.x + p2.x) / 2 + nx * bendAmt;
      const cy = (p1.y + p2.y) / 2 + ny * bendAmt;
      // Midpoint along Quadratic Bezier at t=0.5
      const midX = 0.25 * p1.x + 0.5 * cx + 0.25 * p2.x;
      const midY = 0.25 * p1.y + 0.5 * cy + 0.25 * p2.y;

      return {
        link,
        pathD: `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
        midX,
        midY,
        color: linkColor(link),
      };
    });
  }, [links, posMap]);

  const previewPathD = useMemo(() => {
    if (!connectMode || !fromId) return null;
    const p1 = posMap[fromId];
    const p2 = toId ? posMap[toId] : cursorPt;
    if (!p1 || !p2) return null;
    const cx = (p1.x + p2.x) / 2;
    const cy = (p1.y + p2.y) / 2 - 32;
    return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }, [connectMode, fromId, toId, cursorPt, posMap]);

  return (
    <div className="ko-sheet" role="dialog" aria-label="Peta Topologi Kabel Fiber Interaktif" onClick={onClose}>
      <div
        className="ko-sheet-in noc-topo-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="noc-topo-head">
          <div>
            <h3 style={{ margin: 0 }}>🗺 Peta Topologi Kabel Fiber Interaktif (Live 2D + 3D)</h3>
            <small style={{ color: '#94a3b8' }}>
              {connectMode
                ? '🔌 MODE TARIK KABEL AKTIF: Klik Router Asal → lalu klik Router Tujuan'
                : '✋ Drag node router untuk atur posisi · Klik 🔌 Tarik Kabel FO untuk sambung jalur manual'}
            </small>
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className={connectMode ? 'noc-btn-reject' : 'noc-btn-approve'}
              style={{ marginTop: 0 }}
              onClick={() => {
                setConnectMode((v) => !v);
                setFromId(null);
                setToId(null);
                setCursorPt(null);
                setSelectedLinkId(null);
              }}
            >
              {connectMode ? '✕ Batal Tarik Kabel' : '🔌 Tarik Kabel FO'}
            </button>
            <button type="button" onClick={onClose} style={{ marginTop: 0 }}>
              Tutup
            </button>
          </div>
        </div>

        {/* Inline Mini Form when From & To Router are chosen */}
        {fromAgent && toAgent && (
          <form className="noc-topo-form" onSubmit={(e) => void handleCreateCable(e)}>
            <div className="noc-topo-form-title">
              🔌 Sambung Kabel: <b>{fromAgent.routerConfig?.name ?? fromAgent.nama}</b> ──▶{' '}
              <b>{toAgent.routerConfig?.name ?? toAgent.nama}</b>
            </div>
            <div className="noc-topo-form-grid">
              <label>
                <span>Port / Interface Asal</span>
                <select value={fromIface} onChange={(e) => setFromIface(e.target.value)}>
                  <option value="">(Pilih interface asal — opsional)</option>
                  {(fromAgent.telemetry?.interfaces ?? []).map((ifc) => (
                    <option key={ifc.name} value={ifc.name}>
                      {ifc.name} ({ifc.running ? 'UP' : 'DN'} · {Number((ifc.rxMbps + ifc.txMbps).toFixed(1))} Mbps)
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Port / Interface Tujuan</span>
                <select value={toIface} onChange={(e) => setToIface(e.target.value)}>
                  <option value="">(Pilih interface tujuan — opsional)</option>
                  {(toAgent.telemetry?.interfaces ?? []).map((ifc) => (
                    <option key={ifc.name} value={ifc.name}>
                      {ifc.name} ({ifc.running ? 'UP' : 'DN'} · {Number((ifc.rxMbps + ifc.txMbps).toFixed(1))} Mbps)
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Label Jalur (mis. FO Backbone / vlan2000)</span>
                <input
                  value={cableLabel}
                  onChange={(e) => setCableLabel(e.target.value)}
                  placeholder="Contoh: FO Suplai CCR Mongkonai"
                />
              </label>
              <label>
                <span>Jenis Kabel Fiber</span>
                <select value={fiberType} onChange={(e) => setFiberType(e.target.value as LiveFiberLinkType)}>
                  <option value="backbone">🔵 Backbone Utama (Cyan)</option>
                  <option value="vlan">🟡 VLAN Utama (Emas)</option>
                  <option value="olt">🟢 Distribusi / OLT (Hijau)</option>
                  <option value="backup">🟣 Jalur Backup (Ungu)</option>
                </select>
              </label>
            </div>
            <div className="noc-btn-row" style={{ marginTop: '8px' }}>
              <button type="submit" className="noc-btn-approve" disabled={busy}>
                {busy ? 'Memasang…' : '✅ Pasang Kabel FO'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setFromId(null);
                  setToId(null);
                }}
              >
                Ulangi
              </button>
            </div>
          </form>
        )}

        {/* Selected Existing Cable Inspector */}
        {selectedLink && !toAgent && (
          <div className="noc-topo-inspector">
            <div>
              <strong>
                🔗 {selectedLink.fromRouterName} ({selectedLink.fromInterface || 'port'}) ──▶ {selectedLink.toRouterName} (
                {selectedLink.toInterface || 'port'})
              </strong>
              <small style={{ display: 'block', color: '#cbd5e1' }}>
                Label: {selectedLink.label} · Trafik Live: <b>{selectedLink.liveMbps} Mbps</b> · Status:{' '}
                <b>{selectedLink.status.toUpperCase()}</b> ({selectedLink.statusReason})
              </small>
            </div>
            <button type="button" className="noc-btn-reject" disabled={busy} onClick={() => void handleDeleteSelected()}>
              🗑 Hapus Kabel
            </button>
          </div>
        )}

        {feedback && <p className={`noc-feedback ${feedback.ok ? 'is-ok' : 'is-err'}`}>{feedback.text}</p>}

        {/* Interactive Dark Datacenter SVG Fiber Map */}
        <div className="noc-topo-canvas-wrap">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${MAP_W} ${MAP_H}`}
            className="noc-topo-svg"
            onPointerMove={handleSvgPointerMove}
            onPointerUp={handleSvgPointerUp}
            onPointerLeave={handleSvgPointerUp}
            onClick={() => setSelectedLinkId(null)}
          >
            <defs>
              <pattern id="topo-grid" width="32" height="32" patternUnits="userSpaceOnUse">
                <path d="M 32 0 L 0 0 0 32" fill="none" stroke="rgba(56,189,248,0.09)" strokeWidth="1" />
              </pattern>
              <filter id="fo-glow" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="3.2" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            <rect x="0" y="0" width={MAP_W} height={MAP_H} fill="#060d1b" />
            <rect x="0" y="0" width={MAP_W} height={MAP_H} fill="url(#topo-grid)" />

            {/* Live Fiber Optic Curves */}
            {renderedLinks.map(({ link, pathD, midX, midY, color }) => {
              const isSelected = selectedLinkId === link.id;
              return (
                <g
                  key={link.id}
                  style={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedLinkId(link.id);
                  }}
                >
                  {/* Wide transparent hit area for easy clicking */}
                  <path d={pathD} fill="none" stroke="transparent" strokeWidth="18" />
                  {/* Glowing fiber jacket */}
                  <path
                    d={pathD}
                    fill="none"
                    stroke={color}
                    strokeWidth={isSelected ? 5 : 3.2}
                    strokeOpacity={0.35}
                    filter="url(#fo-glow)"
                  />
                  {/* Animated fiber light core */}
                  <path
                    d={pathD}
                    fill="none"
                    stroke={color}
                    strokeWidth={isSelected ? 3.2 : 2.2}
                    strokeDasharray={link.status === 'down' ? '8 6' : '10 8'}
                    className={link.status === 'down' ? 'noc-fo-down' : 'noc-fo-flow'}
                  />
                  {/* Midpoint live Mbps & label pill */}
                  <g transform={`translate(${midX.toFixed(1)}, ${midY.toFixed(1)})`}>
                    <rect
                      x="-62"
                      y="-13"
                      width="124"
                      height="26"
                      rx="13"
                      fill="#0b162c"
                      stroke={color}
                      strokeWidth={isSelected ? 2 : 1.2}
                    />
                    <text
                      x="0"
                      y="-1"
                      textAnchor="middle"
                      fill="#f8fafc"
                      fontSize="9.5"
                      fontWeight="700"
                      fontFamily="ui-monospace, monospace"
                    >
                      {(link.fromInterface || link.label).slice(0, 17)}
                    </text>
                    <text
                      x="0"
                      y="9.5"
                      textAnchor="middle"
                      fill={color}
                      fontSize="9"
                      fontWeight="700"
                      fontFamily="ui-monospace, monospace"
                    >
                      {link.status === 'down' ? 'LINK DOWN!' : `${link.liveMbps} Mbps · ${link.status.toUpperCase()}`}
                    </text>
                  </g>
                </g>
              );
            })}

            {/* Live flexible preview curve while connecting manually */}
            {previewPathD && (
              <path
                d={previewPathD}
                fill="none"
                stroke="#fbbf24"
                strokeWidth="3"
                strokeDasharray="7 6"
                className="noc-fo-flow"
              />
            )}

            {/* Draggable Router Nodes */}
            {agents.map((ag) => {
              const p = posMap[ag.routerId] ?? { x: 200, y: 200 };
              const t = ag.telemetry;
              const isFrom = fromId === ag.routerId;
              const isTo = toId === ag.routerId;
              const hasMassDrop = Boolean(t?.pppoeDrop?.activeIncident);
              const borderCol = isFrom || isTo
                ? '#fbbf24'
                : hasMassDrop || ag.mendesak.length > 0
                  ? '#ef4444'
                  : !t?.reachable
                    ? '#ef4444'
                    : ag.routerConfig?.simulated
                      ? '#64748b'
                      : '#22c55e';
              const pingMs = t?.interfacePingResult?.avgMs ?? t?.ping?.avgMs;

              return (
                <g
                  key={ag.routerId}
                  transform={`translate(${(p.x - NODE_W / 2).toFixed(1)}, ${(p.y - NODE_H / 2).toFixed(1)})`}
                  style={{ cursor: connectMode ? 'crosshair' : 'grab' }}
                  onPointerDown={(e) => handleNodePointerDown(e, ag.routerId)}
                  onDoubleClick={() => onOpenRouter(ag.routerId)}
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx="12"
                    fill="#0f1b33"
                    stroke={borderCol}
                    strokeWidth={isFrom || isTo ? 2.8 : 1.6}
                    filter={isFrom || isTo ? 'url(#fo-glow)' : undefined}
                  />
                  {/* Left color accent strip */}
                  <rect x="0" y="0" width="6" height={NODE_H} rx="3" fill={ag.warna} />
                  {/* Status dot */}
                  <circle cx={NODE_W - 14} cy="15" r="4.5" fill={borderCol} />
                  <text x="14" y="20" fill="#f8fafc" fontSize="11.5" fontWeight="800" fontFamily="system-ui, sans-serif">
                    {(ag.routerConfig?.name ?? ag.nama).slice(0, 19)}
                  </text>
                  <text x="14" y="36" fill="#94a3b8" fontSize="9.5" fontFamily="ui-monospace, monospace">
                    {ag.nama.slice(0, 22)}
                  </text>
                  <text x="14" y="54" fill="#38bdf8" fontSize="9.5" fontWeight="700" fontFamily="ui-monospace, monospace">
                    {t
                      ? `CPU ${t.cpuLoadPercent}% · ${pingMs !== null && pingMs !== undefined ? `${pingMs}ms` : ag.routerConfig?.simulated ? 'SIM' : 'RTO'}${t.activePppoeCount > 0 ? ` · P:${t.activePppoeCount}` : ''}`
                      : 'Menghubungi…'}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        <div className="noc-topo-legend">
          <span>🔵 Backbone</span>
          <span>🟡 VLAN Utama</span>
          <span>🟢 OLT / Distribusi</span>
          <span>🟣 Backup</span>
          <span>🔴 Link Down / Putus</span>
          <span style={{ marginLeft: 'auto', opacity: 0.75 }}>
            Total Kabel Manual: <b>{links.length}</b> · Double-klik node untuk buka detail router
          </span>
        </div>
      </div>
    </div>
  );
}
