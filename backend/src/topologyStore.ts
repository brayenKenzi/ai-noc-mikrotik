import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  FiberLinkType,
  LiveTopologyLink,
  RouterDevice,
  RouterTelemetry,
  TopologyLink,
  TopologyNodePosition,
} from './types.js';

interface PersistedTopology {
  readonly links: readonly TopologyLink[];
  readonly positions: readonly TopologyNodePosition[];
}

export interface NewTopologyLinkInput {
  readonly fromRouterId: string;
  readonly fromInterface: string;
  readonly toRouterId: string;
  readonly toInterface: string;
  readonly label?: string;
  readonly fiberType?: FiberLinkType;
  readonly color?: string;
}

const DEFAULT_FIBER_COLORS: Record<FiberLinkType, string> = {
  backbone: '#38bdf8',
  vlan: '#fbbf24',
  olt: '#22c55e',
  backup: '#a855f7',
};

/**
 * Persists user-drawn manual Fiber Topology cables & 2D map node coordinates
 * (`data/topology-links.json`) and computes real-time link health & live Mbps from router telemetry.
 */
export class TopologyStore {
  private readonly persistPath: string;
  private links: readonly TopologyLink[] = [];
  private positions: readonly TopologyNodePosition[] = [];
  private persistChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.persistPath = path.join(dataDir, 'topology-links.json');
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedTopology>;
      this.links = Array.isArray(parsed.links) ? parsed.links : [];
      this.positions = Array.isArray(parsed.positions) ? parsed.positions : [];
    } catch {
      // Start clean with 0 auto-forced cables so Admin draws exact physical fiber routes manually via GUI!
      this.links = [];
      this.positions = [];
      await this.persist();
    }
  }

  getLinks(): readonly TopologyLink[] {
    return this.links;
  }

  getPositions(): readonly TopologyNodePosition[] {
    return this.positions;
  }

  async addLink(input: NewTopologyLinkInput): Promise<TopologyLink> {
    if (input.fromRouterId === input.toRouterId) {
      throw new Error('Router asal dan tujuan kabel tidak boleh sama');
    }
    const fiberType: FiberLinkType = input.fiberType ?? 'backbone';
    const created: TopologyLink = {
      id: `fo-${crypto.randomUUID().slice(0, 8)}`,
      fromRouterId: input.fromRouterId.trim(),
      fromInterface: input.fromInterface.trim(),
      toRouterId: input.toRouterId.trim(),
      toInterface: input.toInterface.trim(),
      label: input.label?.trim() || `${input.fromInterface.trim() || 'FO'} → ${input.toInterface.trim() || 'LINK'}`,
      fiberType,
      color: input.color?.trim() || DEFAULT_FIBER_COLORS[fiberType],
    };
    this.links = [...this.links, created];
    await this.persist();
    return created;
  }

  async deleteLink(linkId: string): Promise<void> {
    const exists = this.links.some((l) => l.id === linkId);
    if (!exists) {
      throw new Error(`Kabel topologi ${linkId} tidak ditemukan`);
    }
    this.links = this.links.filter((l) => l.id !== linkId);
    await this.persist();
  }

  async savePositions(positions: readonly TopologyNodePosition[]): Promise<void> {
    this.positions = positions.map((p) => ({
      routerId: p.routerId,
      x: Math.round(p.x),
      y: Math.round(p.y),
    }));
    await this.persist();
  }

  async pruneDeletedRouter(routerId: string): Promise<void> {
    const nextLinks = this.links.filter((l) => l.fromRouterId !== routerId && l.toRouterId !== routerId);
    const nextPos = this.positions.filter((p) => p.routerId !== routerId);
    if (nextLinks.length !== this.links.length || nextPos.length !== this.positions.length) {
      this.links = nextLinks;
      this.positions = nextPos;
      await this.persist();
    }
  }

  buildLiveLinks(
    routers: readonly RouterDevice[],
    telemetryMap: ReadonlyMap<string, RouterTelemetry>,
  ): readonly LiveTopologyLink[] {
    const routerById = new Map(routers.map((r) => [r.id, r]));

    return this.links.map((link) => {
      const fromRouter = routerById.get(link.fromRouterId);
      const toRouter = routerById.get(link.toRouterId);
      const fromTel = telemetryMap.get(link.fromRouterId);
      const toTel = telemetryMap.get(link.toRouterId);

      const fromIf = link.fromInterface
        ? fromTel?.interfaces.find((i) => i.name.toLowerCase() === link.fromInterface.toLowerCase())
        : undefined;
      const toIf = link.toInterface
        ? toTel?.interfaces.find((i) => i.name.toLowerCase() === link.toInterface.toLowerCase())
        : undefined;

      const fromWatched = link.fromInterface
        ? fromTel?.watchedLinks?.find((w) => w.name.toLowerCase() === link.fromInterface.toLowerCase())
        : undefined;
      const toWatched = link.toInterface
        ? toTel?.watchedLinks?.find((w) => w.name.toLowerCase() === link.toInterface.toLowerCase())
        : undefined;

      const fromMbps = fromIf ? Number((fromIf.rxMbps + fromIf.txMbps).toFixed(1)) : 0;
      const toMbps = toIf ? Number((toIf.rxMbps + toIf.txMbps).toFixed(1)) : 0;
      const liveMbps = Math.max(fromMbps, toMbps);

      let status: LiveTopologyLink['status'] = 'ok';
      let statusReason = 'Link UP normal';

      if (fromTel && !fromTel.reachable) {
        status = 'down';
        statusReason = `${fromRouter?.name ?? link.fromRouterId} OFFLINE`;
      } else if (toTel && !toTel.reachable) {
        status = 'down';
        statusReason = `${toRouter?.name ?? link.toRouterId} OFFLINE`;
      } else if (fromIf && !fromIf.running && !fromIf.disabled) {
        status = 'down';
        statusReason = `Port ${fromIf.name} pada ${fromRouter?.name ?? link.fromRouterId} DOWN`;
      } else if (toIf && !toIf.running && !toIf.disabled) {
        status = 'down';
        statusReason = `Port ${toIf.name} pada ${toRouter?.name ?? link.toRouterId} DOWN`;
      } else if (fromWatched?.state === 'drop') {
        status = 'degraded';
        statusReason = `Trafik ${fromWatched.name} drop -${fromWatched.dropPercent}%`;
      } else if (toWatched?.state === 'drop') {
        status = 'degraded';
        statusReason = `Trafik ${toWatched.name} drop -${toWatched.dropPercent}%`;
      } else if (
        fromTel?.interfacePingResult &&
        link.fromInterface &&
        fromTel.interfacePingResult.label.toLowerCase().includes(link.fromInterface.toLowerCase()) &&
        (fromTel.interfacePingResult.status === 'down' || fromTel.interfacePingResult.status === 'critical')
      ) {
        status = fromTel.interfacePingResult.status === 'down' ? 'down' : 'degraded';
        statusReason = `Ping ${fromTel.interfacePingResult.label} ${fromTel.interfacePingResult.avgMs !== null ? `${fromTel.interfacePingResult.avgMs}ms` : 'RTO'}`;
      }

      return {
        ...link,
        fromRouterName: fromRouter?.name ?? link.fromRouterId,
        toRouterName: toRouter?.name ?? link.toRouterId,
        status,
        liveMbps,
        statusReason,
      };
    });
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify({ links: this.links, positions: this.positions }, null, 2);
    this.persistChain = this.persistChain
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
        const tmp = `${this.persistPath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
        await fs.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(tmp, this.persistPath);
      });
    return this.persistChain;
  }
}
