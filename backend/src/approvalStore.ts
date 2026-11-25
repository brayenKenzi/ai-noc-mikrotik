import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ActionProposalPayload, ApprovalTicket, InterfaceMetric, RouterDevice } from './types.js';

/**
 * Immutable Human-in-the-Loop (HITL) Approval Store with serialized atomic JSON persistence.
 * No RouterOS write action can run unless a ticket transitions from PENDING -> APPROVED.
 */
export class ApprovalGateStore {
  private tickets: readonly ApprovalTicket[] = [];
  private readonly persistPath: string;
  private readonly ttlMs: number;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(persistPath: string, ttlMinutes = 30) {
    this.persistPath = persistPath;
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as ApprovalTicket[];
      if (Array.isArray(parsed)) {
        this.tickets = parsed;
      }
    } catch {
      await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
      await this.persist();
    }
  }

  getAll(): readonly ApprovalTicket[] {
    this.expireStaleTickets();
    return this.tickets;
  }

  getPendingForRouter(routerId: string): readonly ApprovalTicket[] {
    this.expireStaleTickets();
    return this.tickets.filter((t) => t.routerId === routerId && t.status === 'PENDING');
  }

  async autoResolveRecoveredInterfaceTickets(
    routerId: string,
    interfaces: readonly InterfaceMetric[],
  ): Promise<boolean> {
    if (interfaces.length === 0) return false;
    const ifMap = new Map(interfaces.map((i) => [i.name.toLowerCase(), i]));
    let changed = false;
    const nowIso = new Date().toISOString();

    this.tickets = this.tickets.map((t) => {
      if (t.routerId !== routerId || t.status !== 'PENDING' || t.proposal.actionType !== 'ENABLE_INTERFACE') {
        return t;
      }
      const targetIf = (t.proposal.parameters.interface ?? '').toLowerCase();
      const liveIf = ifMap.get(targetIf);
      if (liveIf && !liveIf.disabled) {
        changed = true;
        return {
          ...t,
          status: 'EXPIRED' as const,
          decidedBy: 'Auto-Verify',
          decidedAt: nowIso,
          executionResult: liveIf.running
            ? `Otomatis ditutup: interface ${liveIf.name} sudah UP & aktif (tidak di-disable).`
            : `Otomatis ditutup: interface ${liveIf.name} tidak dalam status disabled.`,
        };
      }
      return t;
    });

    if (changed) {
      await this.persist();
    }
    return changed;
  }

  getById(ticketId: string): ApprovalTicket | undefined {
    this.expireStaleTickets();
    return this.tickets.find((t) => t.id === ticketId);
  }

  async createProposalTicket(
    router: RouterDevice,
    incidentSummary: string,
    rootCauseAnalysis: string,
    proposal: ActionProposalPayload,
  ): Promise<{ readonly ticket: ApprovalTicket; readonly createdNew: boolean }> {
    this.expireStaleTickets();

    const duplicate = this.tickets.find(
      (t) =>
        t.routerId === router.id &&
        t.status === 'PENDING' &&
        t.proposal.previewCommand === proposal.previewCommand,
    );
    if (duplicate) {
      return { ticket: duplicate, createdNew: false };
    }

    const now = Date.now();
    const newTicket: ApprovalTicket = {
      id: crypto.randomUUID().slice(0, 8),
      routerId: router.id,
      routerName: router.name,
      agentName: router.agentName,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      status: 'PENDING',
      incidentSummary,
      rootCauseAnalysis,
      proposal,
    };

    this.tickets = [newTicket, ...this.tickets].slice(0, 250);
    await this.persist();
    return { ticket: newTicket, createdNew: true };
  }

  async approveTicket(ticketId: string, decidedBy: string): Promise<ApprovalTicket> {
    this.expireStaleTickets();
    const existing = this.tickets.find((t) => t.id === ticketId);
    if (!existing) {
      throw new Error(`Ticket ${ticketId} tidak ditemukan`);
    }
    if (existing.status !== 'PENDING') {
      throw new Error(`Ticket ${ticketId} sudah berstatus ${existing.status}`);
    }

    const updated: ApprovalTicket = {
      ...existing,
      status: 'APPROVED',
      decidedBy,
      decidedAt: new Date().toISOString(),
    };

    this.tickets = this.tickets.map((t) => (t.id === ticketId ? updated : t));
    await this.persist();
    return updated;
  }

  async markExecutionOutcome(
    ticketId: string,
    succeeded: boolean,
    executionResult: string,
  ): Promise<ApprovalTicket> {
    const existing = this.tickets.find((t) => t.id === ticketId);
    if (!existing) {
      throw new Error(`Ticket ${ticketId} tidak ditemukan`);
    }

    const updated: ApprovalTicket = {
      ...existing,
      status: succeeded ? 'EXECUTED' : 'FAILED',
      executionResult,
    };

    this.tickets = this.tickets.map((t) => (t.id === ticketId ? updated : t));
    await this.persist();
    return updated;
  }

  async rejectTicket(ticketId: string, decidedBy: string): Promise<ApprovalTicket> {
    this.expireStaleTickets();
    const existing = this.tickets.find((t) => t.id === ticketId);
    if (!existing) {
      throw new Error(`Ticket ${ticketId} tidak ditemukan`);
    }
    if (existing.status !== 'PENDING') {
      throw new Error(`Ticket ${ticketId} sudah berstatus ${existing.status}`);
    }

    const updated: ApprovalTicket = {
      ...existing,
      status: 'REJECTED',
      decidedBy,
      decidedAt: new Date().toISOString(),
    };

    this.tickets = this.tickets.map((t) => (t.id === ticketId ? updated : t));
    await this.persist();
    return updated;
  }

  private expireStaleTickets(): void {
    const nowIso = new Date().toISOString();
    let changed = false;
    const next = this.tickets.map((t) => {
      if (t.status === 'PENDING' && t.expiresAt < nowIso) {
        changed = true;
        return { ...t, status: 'EXPIRED' as const };
      }
      return t;
    });
    if (changed) {
      this.tickets = next;
      void this.persist();
    }
  }

  private persist(): Promise<void> {
    const snapshotJson = JSON.stringify(this.tickets, null, 2);
    this.persistChain = this.persistChain
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
        const tmpPath = `${this.persistPath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
        await fs.writeFile(tmpPath, snapshotJson, 'utf8');
        await fs.rename(tmpPath, this.persistPath);
      });
    return this.persistChain;
  }
}
