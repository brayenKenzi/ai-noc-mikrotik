import { isOffPeakQuietHour } from './trafficPatternLearner.js';
import type { AgentDutyRole, InterfaceMetric, RouterDevice, WatchedLinkStatus } from './types.js';

export interface LinkWatchdogEvent {
  readonly key: string;
  readonly kind: 'down' | 'drop' | 'recovered';
  readonly interfaceName: string;
  readonly currentMbps: number;
  readonly baselineMbps: number;
  readonly dropPercent: number;
  readonly streak: number;
  readonly message: string;
}

interface LinkTrackState {
  baselineMbps: number;
  samples: number;
  everUp: boolean;
  downStreak: number;
  dropStreak: number;
  okStreak: number;
  activeAlertKind: 'down' | 'drop' | null;
}

/**
 * Default smart role profile & duty label per router when not explicitly overridden in GUI.
 */
export function resolveRouterDutyProfile(router: RouterDevice): {
  readonly dutyRole: AgentDutyRole;
  readonly dutyLabel: string;
  readonly watchedInterfaces: readonly string[];
  readonly trafficDropThresholdPct: number;
  readonly minTrafficMbps: number;
  readonly interfacePing: { readonly interfaceName: string; readonly target: string; readonly warnMs?: number; readonly critMs?: number } | null;
  readonly customPrompt: string;
} {
  const idLower = router.id.toLowerCase();
  const nameLower = router.name.toLowerCase();

  let defaultRole: AgentDutyRole = 'branch_dist';
  let defaultLabel = 'Distribusi Cabang (PPPoE & Hotspot)';
  let defaultWatched: readonly string[] = [];
  let defaultDropPct = 55;
  let defaultMinMbps = 0;
  let defaultIfPing: { readonly interfaceName: string; readonly target: string; readonly warnMs?: number; readonly critMs?: number } | null = null;
  let defaultPrompt = '';

  if (idLower === 'core-mongkonai' || (nameLower.includes('core') && nameLower.includes('mongkonai'))) {
    defaultRole = 'core_vlan_watchdog';
    defaultLabel = 'Core VLAN Watchdog (vlan2000-CMK)';
    defaultWatched = ['vlan2000-CMK', 'ether1-METRO CMK', 'ether13-OUT CCR MONGKONAI'];
    defaultDropPct = 75;
    defaultMinMbps = 0;
    defaultIfPing = { interfaceName: 'vlan2000-CMK', target: '1.1.1.1', warnMs: 80, critMs: 140 };
    defaultPrompt = `Pantau stabilitas vlan2000-CMK dan hasil ping internet pada ${router.name}. Laporkan ke SPV NOC hanya bila link terputus atau ping RTO terkonfirmasi.`;
  } else if (idLower === 'crs-backbone-01') {
    defaultRole = 'backbone_master';
    defaultLabel = 'Master Backbone & Suplai CRS';
    defaultWatched = [
      'ether1-RB CORE MONGKONAI',
      'sfp-sfpplus1-KOTOBANGON',
      'sfp-sfpplus2-ANDIKA',
      'sfp-sfpplus3-ESI',
      'sfp5-TO LOLAN-BANGO',
    ];
    defaultDropPct = 80;
    defaultMinMbps = 0;
    defaultPrompt = `Kendalikan seluruh jalur ethernet/SFP utama pada ${router.name} dan pantau redaman optik dBm serta status fisik link ke CRS distribusi.`;
  } else if (router.role === 'core' || nameLower.includes('crs')) {
    defaultRole = 'link_guard';
    defaultLabel = 'Link & SFP Backbone Guard';
    defaultWatched = ['sfp1-MONGKONAI'];
    defaultDropPct = 80;
    defaultMinMbps = 0;
    defaultPrompt = `Awasi link ethernet, SFP backbone, dan redaman dBm pada ${router.name}. Laporkan ke SPV NOC bila link fisik putus atau redaman kritis.`;
  } else if (router.role === 'bras' || nameLower.includes('ccr')) {
    defaultRole = 'bras_gateway';
    defaultLabel = 'BRAS Pusat (PPPoE, Hotspot & OLT)';
    defaultWatched = ['ether1-UP LINK', 'bridge-OLT'];
    defaultDropPct = 80;
    defaultMinMbps = 0;
    defaultPrompt = `Awasi kestabilan sesi PPPoE, Hotspot, autentikasi RADIUS, dan trafik uplink/OLT pada ${router.name}.`;
  }

  return {
    dutyRole: router.dutyRole ?? defaultRole,
    dutyLabel: router.dutyLabel?.trim() || defaultLabel,
    watchedInterfaces: router.watchedInterfaces !== undefined ? router.watchedInterfaces : defaultWatched,
    trafficDropThresholdPct: router.trafficDropThresholdPct ?? defaultDropPct,
    minTrafficMbps: router.minTrafficMbps ?? defaultMinMbps,
    interfacePing: router.interfacePing !== undefined ? router.interfacePing : defaultIfPing,
    customPrompt: router.customPrompt !== undefined ? router.customPrompt : defaultPrompt,
  };
}

/**
 * Tracks rolling traffic baselines & link UP/DOWN streaks per router interface
 * so Backbone CRS & CORE MONGKONAI agents catch real Link Down / Traffic Drop events
 * without false-positive spam!
 */
export class LinkWatchdogEngine {
  private readonly states = new Map<string, LinkTrackState>();
  private readonly latestWatched = new Map<string, readonly WatchedLinkStatus[]>();

  getWatchedStatus(routerId: string): readonly WatchedLinkStatus[] {
    return this.latestWatched.get(routerId) ?? [];
  }

  clearRouter(routerId: string): void {
    this.latestWatched.delete(routerId);
    for (const key of this.states.keys()) {
      if (key.startsWith(`${routerId}:`)) {
        this.states.delete(key);
      }
    }
  }

  evaluateRouterInterfaces(
    router: RouterDevice,
    interfaces: readonly InterfaceMetric[],
    confirmCount = 3,
    isNormalHourlyTraffic?: (interfaceName: string, currentMbps: number) => boolean,
    now = new Date(),
  ): { readonly statuses: readonly WatchedLinkStatus[]; readonly events: readonly LinkWatchdogEvent[] } {
    const profile = resolveRouterDutyProfile(router);
    const watchedNamesLower = new Set(profile.watchedInterfaces.map((n) => n.toLowerCase()));
    const isBackboneAuto = profile.dutyRole === 'backbone_master' || profile.dutyRole === 'link_guard';

    // Select interfaces to watch: explicitly configured ones + active physical SFP/Ether uplinks on CRS backbone routers
    const targets = interfaces.filter((ifc) => {
      const lower = ifc.name.toLowerCase();
      if (watchedNamesLower.has(lower)) return true;
      if (isBackboneAuto && !ifc.disabled && (lower.startsWith('sfp') || lower.startsWith('ether') || lower.startsWith('combo'))) {
        return ifc.running || lower.includes('-');
      }
      return false;
    });

    const statuses: WatchedLinkStatus[] = [];
    const events: LinkWatchdogEvent[] = [];
    const downConfirm = Math.max(3, confirmCount);
    const dropConfirm = Math.max(6, confirmCount + 3); // Sustained frozen-traffic check

    for (const ifc of targets) {
      const key = `${router.id}:${ifc.name}`;
      const totalMbps = Number((ifc.rxMbps + ifc.txMbps).toFixed(2));
      const explicitWatch = watchedNamesLower.has(ifc.name.toLowerCase());

      let st = this.states.get(key);
      if (!st) {
        st = {
          baselineMbps: totalMbps,
          samples: 0,
          everUp: ifc.running,
          downStreak: 0,
          dropStreak: 0,
          okStreak: 0,
          activeAlertKind: null,
        };
        this.states.set(key, st);
      }

      if (ifc.running) {
        st.everUp = true;
      }

      let linkState: WatchedLinkStatus['state'] = 'ok';
      let dropPercent = 0;

      // 1. Check physical LINK DOWN (port disconnected / LOS)
      if (!ifc.disabled && !ifc.running && (explicitWatch || st.everUp)) {
        linkState = 'down';
        st.downStreak += 1;
        st.dropStreak = 0;
        st.okStreak = 0;

        if (st.downStreak === downConfirm && st.activeAlertKind !== 'down') {
          st.activeAlertKind = 'down';
          events.push({
            key: `linkdown:${key}`,
            kind: 'down',
            interfaceName: ifc.name,
            currentMbps: totalMbps,
            baselineMbps: Number(st.baselineMbps.toFixed(1)),
            dropPercent: 100,
            streak: st.downStreak,
            message: `Link fisik ${ifc.name} pada ${router.name} PUTUS / DOWN (${st.downStreak}x pengecekan berturut-turut)`,
          });
        }
      } else if (ifc.running) {
        st.downStreak = 0;

        const minBaselineForDrop = Math.max(18, profile.minTrafficMbps * 1.5);
        const baselineReady = st.samples >= 6 && st.baselineMbps >= minBaselineForDrop;
        if (baselineReady && totalMbps < st.baselineMbps) {
          dropPercent = Math.round(((st.baselineMbps - totalMbps) / st.baselineMbps) * 100);
        }

        // Suppress false nighttime/off-peak or normal subscriber-usage dips!
        const quietNight = isOffPeakQuietHour(now);
        const normalByLearner = isNormalHourlyTraffic ? isNormalHourlyTraffic(ifc.name, totalMbps) : false;

        const belowMinFloor =
          !quietNight &&
          !normalByLearner &&
          explicitWatch &&
          profile.minTrafficMbps > 0 &&
          st.samples >= 6 &&
          st.baselineMbps >= profile.minTrafficMbps &&
          totalMbps < Math.min(1.0, profile.minTrafficMbps);

        // Only flag 'drop' on near-dead / frozen traffic collapse during active hours (never normal night dips!)
        const severeCollapse =
          !quietNight &&
          !normalByLearner &&
          baselineReady &&
          dropPercent >= Math.max(70, profile.trafficDropThresholdPct) &&
          totalMbps < 1.2;

        if (severeCollapse || belowMinFloor) {
          linkState = 'drop';
          st.dropStreak += 1;
          st.okStreak = 0;
          // Slowly adapt baseline even during sustained low traffic so it never stays frozen at evening peak all night
          st.baselineMbps = st.baselineMbps * 0.985 + totalMbps * 0.015;

          if (st.dropStreak === dropConfirm && st.activeAlertKind !== 'drop') {
            st.activeAlertKind = 'drop';
            events.push({
              key: `linkdrop:${key}`,
              kind: 'drop',
              interfaceName: ifc.name,
              currentMbps: totalMbps,
              baselineMbps: Number(st.baselineMbps.toFixed(1)),
              dropPercent,
              streak: st.dropStreak,
              message: `Trafik ${ifc.name} pada ${router.name} anjlok mendekati 0 Mbps (${totalMbps} Mbps dari rata-rata ~${st.baselineMbps.toFixed(1)} Mbps)`,
            });
          }
        } else {
          // Normal or off-peak traffic — smoothly adapt rolling EWMA baseline
          st.dropStreak = 0;
          if (st.samples === 0 && totalMbps > 0) {
            st.baselineMbps = totalMbps;
          } else if (totalMbps > 0 || st.samples > 0) {
            st.baselineMbps = st.baselineMbps * 0.9 + totalMbps * 0.1;
          }
          st.samples += 1;

          if (st.activeAlertKind !== null) {
            st.okStreak += 1;
            if (st.okStreak >= downConfirm) {
              const prevKind = st.activeAlertKind;
              st.activeAlertKind = null;
              st.okStreak = 0;
              events.push({
                key: `${prevKind === 'down' ? 'linkdown' : 'linkdrop'}:${key}`,
                kind: 'recovered',
                interfaceName: ifc.name,
                currentMbps: totalMbps,
                baselineMbps: Number(st.baselineMbps.toFixed(1)),
                dropPercent: 0,
                streak: downConfirm,
                message: `Link ${ifc.name} pada ${router.name} kembali normal (UP · ${totalMbps} Mbps)`,
              });
            }
          }
        }
      }

      statuses.push({
        name: ifc.name,
        running: ifc.running,
        disabled: ifc.disabled,
        rxMbps: ifc.rxMbps,
        txMbps: ifc.txMbps,
        totalMbps,
        baselineMbps: Number(st.baselineMbps.toFixed(1)),
        dropPercent,
        state: linkState,
      });
    }

    this.latestWatched.set(router.id, statuses);
    return { statuses, events };
  }
}
