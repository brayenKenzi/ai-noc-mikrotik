import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';

export interface MonitorPingFeed {
  readonly key: string;
  readonly label: string;
  readonly host: string;
  readonly simulated: boolean;
  readonly reachable: boolean;
  readonly cpuPct: number;
  readonly pppoe: number;
  readonly hotspot: number;
  readonly pingAvgMs: number | null;
  readonly pingLossPct: number;
  readonly pingStatus: 'ok' | 'high' | 'critical' | 'down';
  readonly hasAlert: boolean;
}

export interface ExternalPingFeed {
  readonly target: string;
  readonly label: string;
  readonly avgMs: number | null;
  readonly packetLossPercent: number;
  readonly status: 'ok' | 'high' | 'critical' | 'down';
}

export interface MonitorScreenController {
  readonly primaryTex: CanvasTexture;
  readonly secondaryTex: CanvasTexture;
  readonly update: (
    tick: number,
    feed: MonitorPingFeed | undefined,
    allFeeds: readonly MonitorPingFeed[],
    externalPings: readonly ExternalPingFeed[],
  ) => void;
  readonly dispose: () => void;
}

export interface VideoWallController {
  readonly texture: CanvasTexture;
  readonly update: (
    tick: number,
    allFeeds: readonly MonitorPingFeed[],
    externalPings: readonly ExternalPingFeed[],
    activeAlerts: number,
  ) => void;
  readonly dispose: () => void;
}

function statusColor(status: 'ok' | 'high' | 'critical' | 'down'): string {
  if (status === 'down' || status === 'critical') return '#ef4444';
  if (status === 'high') return '#f59e0b';
  return '#22c55e';
}

/**
 * Creates dynamic CanvasTextures for each 3D agent's Primary & Secondary monitors
 * displaying live scrolling ICMP network ping lines + real-time latency waveform.
 */
export function createPingMonitorController(isSupervisor: boolean): MonitorScreenController {
  const c1 = document.createElement('canvas');
  c1.width = 256;
  c1.height = 144;
  const ctx1 = c1.getContext('2d')!;

  const c2 = document.createElement('canvas');
  c2.width = 192;
  c2.height = 128;
  const ctx2 = c2.getContext('2d')!;

  const primaryTex = new CanvasTexture(c1);
  primaryTex.colorSpace = SRGBColorSpace;
  primaryTex.minFilter = LinearFilter;
  primaryTex.magFilter = LinearFilter;

  const secondaryTex = new CanvasTexture(c2);
  secondaryTex.colorSpace = SRGBColorSpace;
  secondaryTex.minFilter = LinearFilter;
  secondaryTex.magFilter = LinearFilter;

  const history: number[] = Array.from({ length: 18 }, () => 8);

  const update = (
    tick: number,
    feed: MonitorPingFeed | undefined,
    allFeeds: readonly MonitorPingFeed[],
    externalPings: readonly ExternalPingFeed[],
  ) => {
    if (isSupervisor) {
      drawSupervisorPrimary(ctx1, c1.width, c1.height, tick, allFeeds, externalPings);
      drawSupervisorSecondary(ctx2, c2.width, c2.height, tick, allFeeds, externalPings);
    } else {
      const sampleMs =
        feed?.pingAvgMs !== null && feed?.pingAvgMs !== undefined
          ? Math.max(0.2, feed.pingAvgMs + Math.sin(tick * 1.3) * 0.4)
          : feed?.reachable
            ? 2.4 + Math.abs(Math.sin(tick * 0.9)) * 4.5
            : 120;
      history.push(sampleMs);
      if (history.length > 18) history.shift();
      drawAgentPingPrimary(ctx1, c1.width, c1.height, tick, feed, history);
      drawAgentTelemetrySecondary(ctx2, c2.width, c2.height, tick, feed);
    }
    primaryTex.needsUpdate = true;
    secondaryTex.needsUpdate = true;
  };

  return {
    primaryTex,
    secondaryTex,
    update,
    dispose: () => {
      primaryTex.dispose();
      secondaryTex.dispose();
    },
  };
}

function drawAgentPingPrimary(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  tick: number,
  feed: MonitorPingFeed | undefined,
  history: readonly number[],
): void {
  const host = feed?.host ?? '192.168.88.1';
  const st = feed ? (!feed.reachable ? 'down' : feed.pingStatus) : 'ok';
  const accent = statusColor(st);
  const avgMs = feed?.pingAvgMs;
  const displayMs =
    avgMs !== null && avgMs !== undefined
      ? `${avgMs.toFixed(1)}ms`
      : feed?.reachable
        ? `${(history[history.length - 1] ?? 2.1).toFixed(1)}ms`
        : 'RTO';

  // Dark terminal backdrop
  ctx.fillStyle = '#040a12';
  ctx.fillRect(0, 0, w, h);

  // Subtle scanline grid
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.08)';
  ctx.lineWidth = 1;
  for (let y = 26; y < h; y += 18) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Top terminal header bar
  ctx.fillStyle = st === 'down' || st === 'critical' ? '#3b0d14' : '#0a1f36';
  ctx.fillRect(0, 0, w, 24);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(11, 12, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = 'bold 11px ui-monospace, Menlo, monospace';
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText(`PING ${host}`, 21, 16);

  // Status badge on top-right
  ctx.fillStyle = accent;
  ctx.fillRect(w - 64, 4, 58, 16);
  ctx.fillStyle = '#04101c';
  ctx.font = 'bold 10px ui-monospace, Menlo, monospace';
  ctx.fillText(displayMs.slice(0, 8), w - 60, 15);

  // Live scrolling ICMP ping lines
  ctx.font = '10px ui-monospace, Menlo, monospace';
  for (let row = 0; row < 5; row++) {
    const seq = 100 + ((tick + row) % 899);
    const y = 39 + row * 14;
    if (st === 'down') {
      ctx.fillStyle = '#f87171';
      ctx.fillText(`Request timeout icmp_seq=${seq}`, 8, y);
    } else {
      const base = avgMs ?? 2.5;
      const jitter = Math.max(0.2, base + Math.sin((tick + row) * 1.7) * Math.min(2.2, base * 0.15 + 0.3));
      ctx.fillStyle = row === 4 ? '#ffffff' : '#86efac';
      ctx.fillText(`64B ${host}: seq=${seq} t=${jitter.toFixed(1)}ms`, 8, y);
    }
  }

  // Bottom live latency sparkline graph
  const graphTop = 108;
  const graphH = 30;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.fillRect(6, graphTop, w - 12, graphH);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  const maxVal = Math.max(20, ...history);
  history.forEach((v, idx) => {
    const gx = 10 + (idx / Math.max(1, history.length - 1)) * (w - 20);
    const gy = graphTop + graphH - 4 - (Math.min(maxVal, v) / maxVal) * (graphH - 8);
    if (idx === 0) ctx.moveTo(gx, gy);
    else ctx.lineTo(gx, gy);
  });
  ctx.stroke();
}

function drawAgentTelemetrySecondary(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  tick: number,
  feed: MonitorPingFeed | undefined,
): void {
  ctx.fillStyle = '#050d18';
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = '#0c223c';
  ctx.fillRect(0, 0, w, 22);
  ctx.font = 'bold 10px ui-monospace, Menlo, monospace';
  ctx.fillStyle = '#38bdf8';
  ctx.fillText((feed?.label ?? 'NOC AGENT').slice(0, 20), 8, 15);

  const cpu = feed?.cpuPct ?? 24;
  const ppp = feed?.pppoe ?? 0;
  const hs = feed?.hotspot ?? 0;
  const loss = feed?.pingLossPct ?? 0;

  const drawBar = (y: number, label: string, valText: string, pct: number, color: string) => {
    ctx.font = 'bold 10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(label, 8, y);
    ctx.fillStyle = color;
    ctx.fillText(valText, w - 58, y);
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(8, y + 4, w - 16, 7);
    ctx.fillStyle = color;
    ctx.fillRect(8, y + 4, Math.max(4, Math.min(1, pct) * (w - 16)), 7);
  };

  drawBar(38, 'CPU', `${cpu}%`, cpu / 100, cpu >= 85 ? '#ef4444' : '#38bdf8');
  drawBar(64, 'PPPoE', `${ppp}`, Math.min(1, ppp / 400), '#a855f7');
  drawBar(90, 'HOTSPOT', `${hs}`, Math.min(1, hs / 200), '#f59e0b');
  drawBar(116, 'LOSS', `${loss}%`, Math.max(0.08, loss / 100), loss > 0 ? '#ef4444' : '#22c55e');

  // Subtle live pulse dot
  ctx.fillStyle = tick % 2 === 0 ? '#22c55e' : '#0ea5e9';
  ctx.beginPath();
  ctx.arc(w - 10, 11, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawSupervisorPrimary(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  tick: number,
  allFeeds: readonly MonitorPingFeed[],
  externalPings: readonly ExternalPingFeed[],
): void {
  ctx.fillStyle = '#040914';
  ctx.fillRect(0, 0, w, h);

  // Golden/Cyan SPV Command Header
  ctx.fillStyle = '#172554';
  ctx.fillRect(0, 0, w, 24);
  ctx.fillStyle = '#fbbf24';
  ctx.font = 'bold 11px ui-monospace, Menlo, monospace';
  ctx.fillText('SPV NOC · ALL-ROUTER PING', 8, 16);

  const liveFirst = [...allFeeds].sort((a, b) => Number(a.simulated) - Number(b.simulated)).slice(0, 5);
  ctx.font = '10px ui-monospace, Menlo, monospace';
  liveFirst.forEach((f, idx) => {
    const y = 39 + idx * 15;
    const st = !f.reachable ? 'down' : f.pingStatus;
    ctx.fillStyle = statusColor(st);
    ctx.fillRect(8, y - 8, 6, 9);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(f.label.slice(0, 14), 19, y);
    const ms = f.pingAvgMs !== null ? `${f.pingAvgMs.toFixed(1)}ms` : f.reachable ? 'SIM' : 'RTO';
    ctx.fillStyle = statusColor(st);
    ctx.fillText(ms, w - 50, y);
  });

  // External internet ping footer
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(6, h - 26, w - 12, 21);
  ctx.font = 'bold 10px ui-monospace, Menlo, monospace';
  const extLine =
    externalPings.length > 0
      ? externalPings.map((e) => `${e.target}:${e.avgMs !== null ? `${e.avgMs}ms` : 'RTO'}`).join('  ')
      : '1.1.1.1:OK   8.8.8.8:OK';
  ctx.fillStyle = tick % 2 === 0 ? '#38bdf8' : '#7dd3fc';
  ctx.fillText(extLine.slice(0, 34), 10, h - 12);
}

function drawSupervisorSecondary(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  tick: number,
  allFeeds: readonly MonitorPingFeed[],
  externalPings: readonly ExternalPingFeed[],
): void {
  ctx.fillStyle = '#050c18';
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = '#1e1b4b';
  ctx.fillRect(0, 0, w, 22);
  ctx.font = 'bold 10px ui-monospace, Menlo, monospace';
  ctx.fillStyle = '#fbbf24';
  ctx.fillText('WA FONNTE & FLEET', 8, 15);

  const online = allFeeds.filter((f) => f.reachable).length;
  const totalHs = allFeeds.reduce((a, b) => a + b.hotspot, 0);
  const totalPpp = allFeeds.reduce((a, b) => a + b.pppoe, 0);
  const alerts = allFeeds.filter((f) => f.hasAlert).length + externalPings.filter((e) => e.status !== 'ok').length;

  ctx.font = 'bold 11px ui-monospace, Menlo, monospace';
  ctx.fillStyle = '#86efac';
  ctx.fillText(`ONLINE : ${online}/${allFeeds.length}`, 10, 42);
  ctx.fillStyle = '#38bdf8';
  ctx.fillText(`PPPoE  : ${totalPpp}`, 10, 62);
  ctx.fillStyle = '#fbbf24';
  ctx.fillText(`HOTSPOT: ${totalHs}`, 10, 82);
  ctx.fillStyle = alerts > 0 ? '#f87171' : '#22c55e';
  ctx.fillText(`ALERTS : ${alerts > 0 ? `${alerts} WA!` : 'AMAN'}`, 10, 102);

  ctx.fillStyle = tick % 2 === 0 ? '#22c55e' : '#fbbf24';
  ctx.fillRect(10, 112, w - 20, 6);
}

/**
 * Giant NOC Video Wall CanvasTexture displaying live network ping bars for the entire Cafe Datacenter.
 */
export function createVideoWallController(): VideoWallController {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 224;
  const ctx = c.getContext('2d')!;
  const texture = new CanvasTexture(c);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  const update = (
    tick: number,
    allFeeds: readonly MonitorPingFeed[],
    externalPings: readonly ExternalPingFeed[],
    activeAlerts: number,
  ) => {
    ctx.fillStyle = '#030914';
    ctx.fillRect(0, 0, c.width, c.height);

    // Header
    ctx.fillStyle = activeAlerts > 0 ? '#450a0a' : '#0b223d';
    ctx.fillRect(0, 0, c.width, 34);
    ctx.font = 'bold 15px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#fbbf24';
    ctx.fillText('SPV NOC · LIVE NETWORK PING WALL', 14, 22);
    ctx.fillStyle = activeAlerts > 0 ? '#fca5a5' : '#4ade80';
    ctx.fillText(activeAlerts > 0 ? `ALERT: ${activeAlerts}` : 'ALL CLEAR', c.width - 115, 22);

    // External DNS Ping cards (top row)
    const dnsList =
      externalPings.length > 0
        ? externalPings
        : [
            { target: '1.1.1.1', label: 'Cloudflare', avgMs: 41, packetLossPercent: 0, status: 'ok' as const },
            { target: '8.8.8.8', label: 'Google DNS', avgMs: 40, packetLossPercent: 0, status: 'ok' as const },
          ];
    dnsList.slice(0, 2).forEach((ep, idx) => {
      const bx = 14 + idx * 246;
      const col = statusColor(ep.status);
      ctx.fillStyle = '#0a192f';
      ctx.fillRect(bx, 44, 236, 44);
      ctx.fillStyle = col;
      ctx.fillRect(bx, 44, 5, 44);
      ctx.font = 'bold 13px ui-monospace, Menlo, monospace';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(`PING ${ep.target}`, bx + 14, 62);
      ctx.fillStyle = col;
      ctx.font = 'bold 16px ui-monospace, Menlo, monospace';
      ctx.fillText(
        ep.avgMs !== null ? `${ep.avgMs.toFixed(1)} ms` : 'RTO / DOWN',
        bx + 14,
        82,
      );
      ctx.font = '11px ui-monospace, Menlo, monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`loss ${ep.packetLossPercent}%`, bx + 150, 81);
    });

    // Router Ping Matrix (bottom area)
    const sorted = [...allFeeds].sort((a, b) => Number(a.simulated) - Number(b.simulated)).slice(0, 6);
    sorted.forEach((f, idx) => {
      const colIdx = idx % 2;
      const rowIdx = Math.floor(idx / 2);
      const bx = 14 + colIdx * 246;
      const by = 98 + rowIdx * 38;
      const st = !f.reachable ? 'down' : f.pingStatus;
      const col = statusColor(st);

      ctx.fillStyle = '#091526';
      ctx.fillRect(bx, by, 236, 32);
      ctx.fillStyle = col;
      ctx.fillRect(bx, by, 4, 32);

      ctx.font = 'bold 11px ui-monospace, Menlo, monospace';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(f.label.slice(0, 16), bx + 10, by + 13);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.fillText(`CPU ${f.cpuPct}% · HS ${f.hotspot} · PPP ${f.pppoe}`, bx + 10, by + 27);

      ctx.font = 'bold 12px ui-monospace, Menlo, monospace';
      ctx.fillStyle = col;
      const pingText = f.pingAvgMs !== null ? `${f.pingAvgMs.toFixed(1)}ms` : f.reachable ? 'LIVE' : 'OFF';
      ctx.fillText(pingText, bx + 174, by + 20);
    });

    // Live ticker indicator
    ctx.fillStyle = tick % 2 === 0 ? '#38bdf8' : '#22c55e';
    ctx.fillRect(0, c.height - 4, c.width, 4);
    texture.needsUpdate = true;
  };

  return {
    texture,
    update,
    dispose: () => texture.dispose(),
  };
}
