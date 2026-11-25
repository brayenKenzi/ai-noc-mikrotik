import fs from 'node:fs/promises';
import path from 'node:path';
import type { OfficeAgentView, RouterDevice, RouterTelemetry } from './types.js';

export interface HourlyBucket {
  readonly avgMbps: number;
  readonly avgUsers: number;
  readonly samples: number;
}

export interface RouterTrafficProfile {
  readonly routerId: string;
  readonly routerName: string;
  readonly peakMbps: number;
  readonly peakHour: number;
  readonly hourly: Readonly<Record<string, HourlyBucket>>;
  readonly interfaceHourlyMbps: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

interface PersistedTrafficPatterns {
  readonly updatedAt: string;
  readonly profiles: Readonly<Record<string, RouterTrafficProfile>>;
}

export function isOffPeakQuietHour(date = new Date()): boolean {
  const h = date.getHours();
  return h >= 22 || h < 7;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Learns 24-hour bandwidth (Mbps) and subscriber (PPPoE + Hotspot) connection patterns
 * per router and per main interface so SPV NOC understands peak vs night quiet hours
 * and never confuses normal nighttime user decline with a network outage.
 */
export class TrafficPatternLearner {
  private readonly filePath: string;
  private profiles: Record<string, RouterTrafficProfile> = {};
  private lastSampleMs = 0;
  private lastFlushMs = 0;
  private dirty = false;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'traffic-patterns.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedTrafficPatterns>;
      if (parsed.profiles && typeof parsed.profiles === 'object') {
        this.profiles = { ...parsed.profiles };
      }
    } catch {
      await this.flush();
    }
  }

  /**
   * Records a fleet observation roughly once every 60s.
   */
  async observeFleet(
    routers: readonly RouterDevice[],
    telemetryMap: ReadonlyMap<string, RouterTelemetry>,
    now = new Date(),
  ): Promise<void> {
    const nowMs = now.getTime();
    if (nowMs - this.lastSampleMs < 55_000) return;
    this.lastSampleMs = nowMs;

    const hourKey = String(now.getHours());

    for (const r of routers) {
      if (r.simulated) continue;
      const tel = telemetryMap.get(r.id);
      if (!tel || !tel.reachable) continue;

      const users = tel.activePppoeCount + tel.activeHotspotCount;
      // Primary throughput indicator = highest active interface total Mbps on this router
      const primaryMbps = tel.interfaces.reduce((max, i) => {
        const tot = i.rxMbps + i.txMbps;
        return tot > max ? tot : max;
      }, 0);

      const prevProfile: RouterTrafficProfile = this.profiles[r.id] ?? {
        routerId: r.id,
        routerName: r.name,
        peakMbps: primaryMbps,
        peakHour: now.getHours(),
        hourly: {},
        interfaceHourlyMbps: {},
      };

      const prevBucket = prevProfile.hourly[hourKey];
      const nextBucket: HourlyBucket = prevBucket
        ? {
            avgMbps: round1(prevBucket.avgMbps * 0.88 + primaryMbps * 0.12),
            avgUsers: Math.round(prevBucket.avgUsers * 0.88 + users * 0.12),
            samples: Math.min(9999, prevBucket.samples + 1),
          }
        : {
            avgMbps: round1(primaryMbps),
            avgUsers: users,
            samples: 1,
          };

      const nextIfHourly: Record<string, Readonly<Record<string, number>>> = {
        ...prevProfile.interfaceHourlyMbps,
      };
      for (const ifc of tel.interfaces.slice(0, 10)) {
        if (!ifc.running) continue;
        const tot = round1(ifc.rxMbps + ifc.txMbps);
        const prevIfMap = nextIfHourly[ifc.name] ?? {};
        const prevVal = prevIfMap[hourKey];
        nextIfHourly[ifc.name] = {
          ...prevIfMap,
          [hourKey]: prevVal !== undefined ? round1(prevVal * 0.88 + tot * 0.12) : tot,
        };
      }

      const isNewPeak = primaryMbps > prevProfile.peakMbps;
      this.profiles = {
        ...this.profiles,
        [r.id]: {
          routerId: r.id,
          routerName: r.name,
          peakMbps: isNewPeak ? round1(primaryMbps) : prevProfile.peakMbps,
          peakHour: isNewPeak ? now.getHours() : prevProfile.peakHour,
          hourly: {
            ...prevProfile.hourly,
            [hourKey]: nextBucket,
          },
          interfaceHourlyMbps: nextIfHourly,
        },
      };
      this.dirty = true;
    }

    if (this.dirty && nowMs - this.lastFlushMs >= 180_000) {
      await this.flush(now);
    }
  }

  getExpectedInterfaceMbps(routerId: string, interfaceName: string, now = new Date()): number | null {
    const prof = this.profiles[routerId];
    if (!prof) return null;
    const val = prof.interfaceHourlyMbps[interfaceName]?.[String(now.getHours())];
    return val !== undefined ? val : null;
  }

  /**
   * Determines whether a lower-than-peak bandwidth reading is simply normal usage / nighttime quiet hours,
   * rather than a broken/frozen link.
   */
  isNormalBandwidthPattern(
    routerId: string,
    interfaceName: string,
    currentMbps: number,
    now = new Date(),
  ): boolean {
    // 1. If link is actively passing >= 1.5 Mbps while UP, it is carrying live user traffic (not dead/frozen)
    if (currentMbps >= 1.5) return true;

    // 2. Off-peak sleeping hours (22:00 - 06:59): quiet traffic is completely normal
    if (isOffPeakQuietHour(now)) return true;

    // 3. Compare against learned hourly average for this exact hour
    const expectedHourMbps = this.getExpectedInterfaceMbps(routerId, interfaceName, now);
    if (expectedHourMbps !== null && expectedHourMbps < 18) {
      return true;
    }

    return false;
  }

  buildFleetPatternContext(agents: readonly OfficeAgentView[], now = new Date()): {
    readonly currentHour: number;
    readonly periodLabel: string;
    readonly routerPatterns: readonly {
      readonly routerName: string;
      readonly agentName: string;
      readonly currentPeakIfMbps: number;
      readonly expectedHourMbps: number | null;
      readonly historicalPeakMbps: number | null;
      readonly historicalPeakHour: number | null;
      readonly patternVerdict: string;
    }[];
  } {
    const hour = now.getHours();
    const periodLabel = isOffPeakQuietHour(now)
      ? 'Jam Istirahat / Off-Peak Malam (penurunan trafik wajar karena pengguna berkurang)'
      : hour >= 18 && hour <= 21
        ? 'Jam Sibuk Puncak Malam (Prime Time Pelanggan)'
        : 'Jam Operasional Siang / Sore';

    const routerPatterns = agents
      .filter((a) => !a.routerConfig.simulated && a.telemetry?.reachable)
      .map((a) => {
        const prof = this.profiles[a.routerId];
        const bucket = prof?.hourly[String(hour)];
        const currentPeakIfMbps = round1(
          (a.telemetry?.interfaces ?? []).reduce((m, i) => Math.max(m, i.rxMbps + i.txMbps), 0),
        );
        const expectedHourMbps = bucket ? bucket.avgMbps : null;

        let patternVerdict = 'Sedang mempelajari pola jam ini';
        if (expectedHourMbps !== null && bucket && bucket.samples >= 2) {
          if (expectedHourMbps < 5 && currentPeakIfMbps < 5) {
            patternVerdict = `Normal rendah sesuai pola jam ${String(hour).padStart(2, '0')}.00`;
          } else if (expectedHourMbps > 0) {
            const ratio = currentPeakIfMbps / expectedHourMbps;
            if (ratio >= 0.55 && ratio <= 1.65) {
              patternVerdict = `Normal sesuai kebiasaan jam ${String(hour).padStart(2, '0')}.00 (~${expectedHourMbps} Mbps)`;
            } else if (ratio > 1.65) {
              patternVerdict = `Trafik lebih ramai dari rata-rata jam ${String(hour).padStart(2, '0')}.00 (~${expectedHourMbps} Mbps)`;
            } else if (isOffPeakQuietHour(now)) {
              patternVerdict = `Trafik malam melandai wajar (rata-rata jam ini ~${expectedHourMbps} Mbps)`;
            } else {
              patternVerdict = `Di bawah rata-rata jam ${String(hour).padStart(2, '0')}.00 (~${expectedHourMbps} Mbps)`;
            }
          }
        } else if (isOffPeakQuietHour(now)) {
          patternVerdict = 'Pola malam normal (pengguna istirahat)';
        }

        return {
          routerName: a.routerConfig.name,
          agentName: a.nama,
          currentPeakIfMbps,
          expectedHourMbps,
          historicalPeakMbps: prof ? prof.peakMbps : null,
          historicalPeakHour: prof ? prof.peakHour : null,
          patternVerdict,
        };
      });

    return {
      currentHour: hour,
      periodLabel,
      routerPatterns,
    };
  }

  async flush(now = new Date()): Promise<void> {
    this.lastFlushMs = now.getTime();
    this.dirty = false;
    const payload: PersistedTrafficPatterns = {
      updatedAt: now.toISOString(),
      profiles: this.profiles,
    };
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }
}
