import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PingMetric } from './types.js';

const execFileAsync = promisify(execFile);

export interface PingThresholds {
  readonly warnMs: number;
  readonly critMs: number;
  readonly lossCritPct: number;
}

export function classifyPingStatus(
  avgMs: number | null,
  packetLossPercent: number,
  thresholds: PingThresholds,
): PingMetric['status'] {
  if (avgMs === null || packetLossPercent >= 100) return 'down';
  if (avgMs >= thresholds.critMs || packetLossPercent >= thresholds.lossCritPct) return 'critical';
  if (avgMs >= thresholds.warnMs || packetLossPercent >= 20) return 'high';
  return 'ok';
}

/**
 * Parses output from both Linux iputils `ping -c 3 -W 2` and Windows `ping -n 3 -w 2000`.
 */
export function parsePingOutput(
  stdout: string,
  target: string,
  label: string,
  thresholds: PingThresholds,
): PingMetric {
  const now = new Date().toISOString();

  // Packet loss percentage (Linux: "0% packet loss", Windows: "(0% loss)")
  const lossMatch = /(\d+(?:\.\d+)?)%\s*(?:packet\s+)?loss/i.exec(stdout);
  const packetLossPercent = lossMatch?.[1] ? Math.round(Number.parseFloat(lossMatch[1])) : 100;

  // Linux rtt min/avg/max/mdev = 0.721/0.845/0.992/0.112 ms
  const linuxRtt = /=\s*([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/[\d.]+)?\s*ms/i.exec(stdout);
  if (linuxRtt?.[1] && linuxRtt[2] && linuxRtt[3]) {
    const minMs = Number(Number.parseFloat(linuxRtt[1]).toFixed(1));
    const avgMs = Number(Number.parseFloat(linuxRtt[2]).toFixed(1));
    const maxMs = Number(Number.parseFloat(linuxRtt[3]).toFixed(1));
    return {
      target,
      label,
      minMs,
      avgMs,
      maxMs,
      packetLossPercent,
      status: classifyPingStatus(avgMs, packetLossPercent, thresholds),
      updatedAt: now,
    };
  }

  // Windows: Minimum = 1ms, Maximum = 2ms, Average = 1ms
  const winRtt = /Minimum\s*=\s*(\d+)ms,\s*Maximum\s*=\s*(\d+)ms,\s*Average\s*=\s*(\d+)ms/i.exec(stdout);
  if (winRtt?.[1] && winRtt[2] && winRtt[3]) {
    const minMs = Number.parseFloat(winRtt[1]);
    const maxMs = Number.parseFloat(winRtt[2]);
    const avgMs = Number.parseFloat(winRtt[3]);
    return {
      target,
      label,
      minMs,
      avgMs,
      maxMs,
      packetLossPercent,
      status: classifyPingStatus(avgMs, packetLossPercent, thresholds),
      updatedAt: now,
    };
  }

  return {
    target,
    label,
    minMs: null,
    avgMs: null,
    maxMs: null,
    packetLossPercent: 100,
    status: 'down',
    updatedAt: now,
  };
}

export async function runSinglePing(
  target: string,
  label: string,
  thresholds: PingThresholds,
): Promise<PingMetric> {
  if (!/^[a-zA-Z0-9._:-]+$/.test(target)) {
    return {
      target,
      label,
      minMs: null,
      avgMs: null,
      maxMs: null,
      packetLossPercent: 100,
      status: 'down',
      updatedAt: new Date().toISOString(),
    };
  }

  const isWin = process.platform === 'win32';
  // Use 5 ICMP packets on Linux (0.2s spacing = ~1s total) for more accurate avg & loss measurement
  const args = isWin ? ['-n', '4', '-w', '1500', target] : ['-c', '5', '-i', '0.2', '-W', '2', target];

  try {
    const { stdout } = await execFileAsync('ping', args, { timeout: 8000 });
    return parsePingOutput(stdout, target, label, thresholds);
  } catch (err) {
    const stdout = (err as { stdout?: string })?.stdout ?? '';
    if (stdout) {
      return parsePingOutput(stdout, target, label, thresholds);
    }
    return {
      target,
      label,
      minMs: null,
      avgMs: null,
      maxMs: null,
      packetLossPercent: 100,
      status: 'down',
      updatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Parses MikroTik RouterOS v6/v7 ping duration strings into milliseconds.
 * Examples: "41ms" -> 41, "41ms359us" -> 41.4, "850us" -> 0.9, "1s20ms" -> 1020
 */
export function parseRouterOsRttMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  let totalMs = 0;
  let matched = false;
  const secMatch = /(?:^|[^a-z])(\d+(?:\.\d+)?)s(?![a-z])/.exec(s);
  if (secMatch?.[1]) {
    totalMs += Number.parseFloat(secMatch[1]) * 1000;
    matched = true;
  }
  const msMatch = /(\d+(?:\.\d+)?)ms/.exec(s);
  if (msMatch?.[1]) {
    totalMs += Number.parseFloat(msMatch[1]);
    matched = true;
  }
  const usMatch = /(\d+(?:\.\d+)?)us/.exec(s);
  if (usMatch?.[1]) {
    totalMs += Number.parseFloat(usMatch[1]) / 1000;
    matched = true;
  }
  if (!matched) {
    const plain = Number.parseFloat(s);
    if (!Number.isNaN(plain)) {
      return Number(plain.toFixed(1));
    }
    return null;
  }
  return Number(totalMs.toFixed(1));
}

/**
 * Converts rows returned by MikroTik `/ping =address=<target> =interface=<iface> =count=4`
 * into a standardized PingMetric with accurate min/avg/max ms and packet loss %.
 */
export function parseRouterOsPingRows(
  rows: readonly Readonly<Record<string, string>>[],
  target: string,
  label: string,
  thresholds: PingThresholds,
): PingMetric {
  const now = new Date().toISOString();
  if (rows.length === 0) {
    return {
      target,
      label,
      minMs: null,
      avgMs: null,
      maxMs: null,
      packetLossPercent: 100,
      status: 'down',
      updatedAt: now,
    };
  }

  const last = rows[rows.length - 1]!;
  const sent = Number.parseInt(last.sent ?? String(rows.length), 10) || rows.length;
  const received = Number.parseInt(last.received ?? '0', 10) || 0;
  const rawLoss = last['packet-loss'];
  const packetLossPercent =
    rawLoss !== undefined && !Number.isNaN(Number.parseFloat(rawLoss))
      ? Math.round(Number.parseFloat(rawLoss))
      : sent > 0
        ? Math.round(((sent - received) / sent) * 100)
        : 100;

  let minMs = parseRouterOsRttMs(last['min-rtt']);
  let avgMs = parseRouterOsRttMs(last['avg-rtt']);
  let maxMs = parseRouterOsRttMs(last['max-rtt']);

  // Fallback: compute from individual packet `time` rows if summary attrs absent
  if (avgMs === null) {
    const times = rows
      .map((r) => parseRouterOsRttMs(r.time))
      .filter((v): v is number => v !== null);
    if (times.length > 0) {
      minMs = Math.min(...times);
      maxMs = Math.max(...times);
      avgMs = Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(1));
    }
  }

  return {
    target,
    label,
    minMs,
    avgMs,
    maxMs,
    packetLossPercent: Math.max(0, Math.min(100, packetLossPercent)),
    status: classifyPingStatus(avgMs, packetLossPercent, thresholds),
    updatedAt: now,
  };
}
