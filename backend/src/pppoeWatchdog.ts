import type { InterfaceMetric, PppoeDropStatus, RouterDevice, WatchedLinkStatus } from './types.js';

export interface PppoeMassDisconnectEvent {
  readonly key: string;
  readonly kind: 'mass_disconnect' | 'recovered';
  readonly previousPeak: number;
  readonly currentCount: number;
  readonly droppedCount: number;
  readonly droppedPercent: number;
  readonly suspectedOltInterfaces: readonly string[];
  readonly message: string;
}

interface PppoeSample {
  readonly count: number;
  readonly tsMs: number;
}

interface PppoeTrackState {
  samples: PppoeSample[];
  dropConfirmStreak: number;
  recoverConfirmStreak: number;
  activeIncidentPeak: number | null;
  latestStatus: PppoeDropStatus | null;
}

/**
 * Detects sudden Mass-Disconnect PPPoE events (instant OLT / Fiber distribution cut detector!).
 * Compares live `activePppoeCount` against rolling 60-second peak and requires 2 consecutive polls
 * (~6 seconds) to confirm real mass-disconnect without false-positive glitches.
 */
export class PppoeMassDisconnectWatchdog {
  private readonly states = new Map<string, PppoeTrackState>();

  getStatus(routerId: string): PppoeDropStatus | null {
    return this.states.get(routerId)?.latestStatus ?? null;
  }

  clearRouter(routerId: string): void {
    this.states.delete(routerId);
  }

  evaluate(
    router: RouterDevice,
    currentCount: number,
    interfaces: readonly InterfaceMetric[],
    watchedLinks: readonly WatchedLinkStatus[] = [],
    minDropThreshold = 15,
    nowMs = Date.now(),
  ): PppoeMassDisconnectEvent | null {
    let st = this.states.get(router.id);
    if (!st) {
      st = {
        samples: [],
        dropConfirmStreak: 0,
        recoverConfirmStreak: 0,
        activeIncidentPeak: null,
        latestStatus: null,
      };
      this.states.set(router.id, st);
    }

    // Keep last 60s of samples (excluding current sample when computing reference peak)
    const windowSamples = st.samples.filter((s) => nowMs - s.tsMs <= 60_000);
    const referencePeak =
      st.activeIncidentPeak ??
      (windowSamples.length > 0 ? Math.max(...windowSamples.map((s) => s.count)) : currentCount);

    st.samples = [...windowSamples, { count: currentCount, tsMs: nowMs }].slice(-25);

    // Need at least 2 prior samples and at least 15 subscribers before checking mass disconnect
    if (windowSamples.length < 2 || referencePeak < 15) {
      return null;
    }

    const droppedCount = Math.max(0, referencePeak - currentCount);
    const droppedPercent = referencePeak > 0 ? Math.round((droppedCount / referencePeak) * 100) : 0;

    // Adaptive threshold: >= minDropThreshold (default 15 users) OR >= 25% on smaller branch routers (>= 10 users)
    const effectiveMinDrop = referencePeak >= 80 ? Math.max(10, minDropThreshold) : Math.max(8, Math.min(minDropThreshold, Math.round(referencePeak * 0.25)));
    const isMassDrop = droppedCount >= effectiveMinDrop && droppedPercent >= 12;

    const suspectedOlts = [
      ...watchedLinks.filter((w) => w.state === 'down' || w.state === 'drop').map((w) => w.name),
      ...interfaces
        .filter((i) => !i.disabled && !i.running && /(olt|pon|pppoe|vlan|uplink)/i.test(i.name))
        .map((i) => i.name),
    ];
    const uniqueSuspected = Array.from(new Set(suspectedOlts)).slice(0, 5);

    if (isMassDrop) {
      st.recoverConfirmStreak = 0;
      st.dropConfirmStreak += 1;

      st.latestStatus = {
        routerId: router.id,
        previousPeak: referencePeak,
        currentCount,
        droppedCount,
        droppedPercent,
        suspectedOltInterfaces: uniqueSuspected,
        activeIncident: st.dropConfirmStreak >= 2 || st.activeIncidentPeak !== null,
        detectedAt: new Date(nowMs).toISOString(),
      };

      // Confirm on 2nd consecutive poll (~6s) to eliminate transient API read hiccups
      if (st.dropConfirmStreak === 2 && st.activeIncidentPeak === null) {
        st.activeIncidentPeak = referencePeak;
        const oltNote =
          uniqueSuspected.length > 0 ? ` | Indikasi interface/OLT terdampak: ${uniqueSuspected.join(', ')}` : '';
        return {
          key: `pppoe_mass:${router.id}`,
          kind: 'mass_disconnect',
          previousPeak: referencePeak,
          currentCount,
          droppedCount,
          droppedPercent,
          suspectedOltInterfaces: uniqueSuspected,
          message: `MASS-DISCONNECT PPPOE: ${droppedCount} pelanggan terputus serentak (${referencePeak} → ${currentCount}, turun ${droppedPercent}%)${oltNote}`,
        };
      }
      return null;
    }

    st.dropConfirmStreak = 0;

    if (st.activeIncidentPeak !== null) {
      const recoveredRatio = st.activeIncidentPeak > 0 ? currentCount / st.activeIncidentPeak : 1;
      if (recoveredRatio >= 0.85) {
        st.recoverConfirmStreak += 1;
        if (st.recoverConfirmStreak >= 3) {
          const prevPeak = st.activeIncidentPeak;
          st.activeIncidentPeak = null;
          st.recoverConfirmStreak = 0;
          st.latestStatus = null;
          return {
            key: `pppoe_mass:${router.id}`,
            kind: 'recovered',
            previousPeak: prevPeak,
            currentCount,
            droppedCount: Math.max(0, prevPeak - currentCount),
            droppedPercent: 0,
            suspectedOltInterfaces: [],
            message: `PPPOE PULIH NORMAL: ${currentCount} sesi kembali online (sebelum gangguan ${prevPeak} sesi)`,
          };
        }
      } else {
        st.recoverConfirmStreak = 0;
      }
    } else {
      st.latestStatus = null;
    }

    return null;
  }
}
