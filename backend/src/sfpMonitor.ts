import type { InterfaceMetric, RouterDevice, SfpOpticalMetric } from './types.js';
import type { RouterOsConnectionOptions, RouterOsSessionPool } from './routerosClient.js';

export interface SfpAlertEvent {
  readonly key: string;
  readonly kind: 'high_attenuation' | 'los' | 'recovered';
  readonly routerId: string;
  readonly routerName: string;
  readonly interfaceName: string;
  readonly rxPowerDbm: number | null;
  readonly txPowerDbm: number | null;
  readonly temperatureC: number | null;
  readonly message: string;
}

function parseFiniteNum(raw: string | undefined): number | null {
  if (!raw || raw.trim() === '') return null;
  const cleaned = raw.replace(/[^0-9.+-]/g, '');
  if (!cleaned) return null;
  const val = Number(cleaned);
  return Number.isFinite(val) ? Math.round(val * 100) / 100 : null;
}

export function parseSfpMonitorRow(
  ifaceName: string,
  row: Readonly<Record<string, string>>,
  warnDbm = -20,
  critDbm = -24,
): SfpOpticalMetric {
  const modulePresent = row['sfp-module-present'] === 'true';
  const linkOk = row.status === 'link-ok';
  const rxPowerDbm = parseFiniteNum(row['sfp-rx-power']);
  const txPowerDbm = parseFiniteNum(row['sfp-tx-power']);
  const temperatureC = parseFiniteNum(row['sfp-temperature']);
  const wavelengthNm = parseFiniteNum(row['sfp-wavelength']);
  const vendor = (row['sfp-vendor-name'] ?? '').trim();

  let health: SfpOpticalMetric['health'] = 'empty';
  if (!modulePresent || (!linkOk && rxPowerDbm === null)) {
    health = 'empty';
  } else if (rxPowerDbm !== null && rxPowerDbm <= critDbm) {
    health = 'critical';
  } else if (!linkOk) {
    health = 'critical';
  } else if (rxPowerDbm !== null && rxPowerDbm <= warnDbm) {
    health = 'warning';
  } else {
    health = 'ok';
  }

  return {
    name: ifaceName,
    modulePresent,
    linkOk,
    rxPowerDbm,
    txPowerDbm,
    temperatureC,
    wavelengthNm,
    vendor,
    health,
  };
}

export async function pollRouterSfpOptics(
  pool: RouterOsSessionPool,
  router: RouterDevice,
  connOpts: RouterOsConnectionOptions,
  interfaces: readonly InterfaceMetric[],
  critDbm = -24,
): Promise<readonly SfpOpticalMetric[]> {
  const sfpNames = interfaces
    .filter((i) => !i.disabled && /sfp/i.test(i.name))
    .map((i) => i.name)
    .slice(0, 16);

  if (sfpNames.length === 0) return [];

  const commands = sfpNames.map((n) => ['/interface/ethernet/monitor', `=numbers=${n}`, '=once=']);
  const outcomes = await pool.runTolerant(router.id, connOpts, commands);

  const warnDbm = Math.max(critDbm + 3.5, -20);
  const metrics: SfpOpticalMetric[] = [];
  for (let i = 0; i < sfpNames.length; i++) {
    const out = outcomes[i];
    if (!out?.ok || !out.rows[0]) continue;
    metrics.push(parseSfpMonitorRow(sfpNames[i]!, out.rows[0], warnDbm, critDbm));
  }
  return metrics;
}

interface PortOpticalState {
  readonly hadActiveLink: boolean;
  readonly critStreak: number;
  readonly okStreak: number;
  readonly activeAlert: boolean;
}

/**
 * Stateful SFP optical watchdog:
 * - Ignores unused SFP slots that never had an active fiber link since boot.
 * - Alerts after `confirmCount` consecutive checks when RX power drops <= critDbm (early warning before FO cut!)
 *   or when an established optical SFP port loses light (LOS).
 */
export class SfpOpticalWatchdog {
  private readonly portStates = new Map<string, PortOpticalState>();

  evaluate(
    router: RouterDevice,
    optics: readonly SfpOpticalMetric[],
    critDbm = -24,
    confirmCount = 3,
  ): { readonly updatedOptics: readonly SfpOpticalMetric[]; readonly events: readonly SfpAlertEvent[] } {
    const events: SfpAlertEvent[] = [];
    const required = Math.max(2, confirmCount);

    const updatedOptics = optics.map((m) => {
      const key = `sfp:${router.id}:${m.name}`;
      const prev = this.portStates.get(key) ?? {
        hadActiveLink: false,
        critStreak: 0,
        okStreak: 0,
        activeAlert: false,
      };

      const nowHasActiveLink = prev.hadActiveLink || (m.modulePresent && m.linkOk);

      // Unused SFP slot (transceiver inserted with no fiber patchcord since boot) -> treat as empty
      if (!nowHasActiveLink && !m.linkOk) {
        this.portStates.set(key, { ...prev, hadActiveLink: false });
        return m.health === 'empty' ? m : { ...m, health: 'empty' as const };
      }

      const isHighAtten = m.modulePresent && m.rxPowerDbm !== null && m.rxPowerDbm <= critDbm;
      const isSuddenLos = prev.hadActiveLink && m.modulePresent && !m.linkOk;

      if (isHighAtten || isSuddenLos) {
        const critStreak = prev.critStreak + 1;
        let activeAlert = prev.activeAlert;
        if (!activeAlert && critStreak >= required) {
          activeAlert = true;
          events.push({
            key,
            kind: isSuddenLos ? 'los' : 'high_attenuation',
            routerId: router.id,
            routerName: router.name,
            interfaceName: m.name,
            rxPowerDbm: m.rxPowerDbm,
            txPowerDbm: m.txPowerDbm,
            temperatureC: m.temperatureC,
            message: isSuddenLos
              ? `Modul SFP ${m.name} kehilangan sinyal optik (LOS / No-Link)${m.rxPowerDbm !== null ? ` · RX ${m.rxPowerDbm} dBm` : ''}`
              : `Redaman optik ${m.name} sangat tinggi: RX ${m.rxPowerDbm} dBm (batas kritis ${critDbm} dBm)${m.txPowerDbm !== null ? ` · TX ${m.txPowerDbm} dBm` : ''}${m.temperatureC !== null ? ` · Suhu ${m.temperatureC}°C` : ''} — rawan putus!`,
          });
        }
        this.portStates.set(key, {
          hadActiveLink: nowHasActiveLink,
          critStreak,
          okStreak: 0,
          activeAlert,
        });
        return { ...m, health: 'critical' as const };
      }

      // Healthy or mild warning
      const okStreak = prev.activeAlert ? prev.okStreak + 1 : 0;
      let activeAlert = prev.activeAlert;
      if (activeAlert && m.linkOk && (m.rxPowerDbm === null || m.rxPowerDbm >= critDbm + 1.5) && okStreak >= required) {
        activeAlert = false;
        events.push({
          key,
          kind: 'recovered',
          routerId: router.id,
          routerName: router.name,
          interfaceName: m.name,
          rxPowerDbm: m.rxPowerDbm,
          txPowerDbm: m.txPowerDbm,
          temperatureC: m.temperatureC,
          message: `Redaman optik ${m.name} kembali aman: RX ${m.rxPowerDbm ?? '-'} dBm · Link OK`,
        });
      }

      this.portStates.set(key, {
        hadActiveLink: nowHasActiveLink,
        critStreak: 0,
        okStreak,
        activeAlert,
      });
      return m;
    });

    return { updatedOptics, events };
  }
}
