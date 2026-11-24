import { z } from 'zod';
import { RouterOsClient } from './routerosClient.js';
import type { ActionProposalPayload, PlaybookActionType, RouterDevice } from './types.js';

const IPv4Schema = z
  .string()
  .regex(/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/, 'Invalid IPv4 address');

const SafeIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Identifier contains unsafe characters');

const TimeoutSchema = z
  .string()
  .regex(/^\d+(s|m|h|d)$/, 'Timeout must match RouterOS duration like 30m, 24h, 7d');

/**
 * Protected management IPs that AI agents are strictly forbidden from blocking or disabling.
 */
const PROTECTED_MANAGEMENT_IPS = new Set(['127.0.0.1']);

function getManagementPrefix(nocServerIp?: string): string | null {
  if (!nocServerIp) return null;
  const parts = nocServerIp.split('.');
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.`;
}

export interface BuiltRouterOsAction {
  /** Optional lookup command to resolve internal RouterOS `.id` before mutation. */
  readonly lookupWords?: readonly string[];
  /** Direct words (when lookupWords is omitted) or mutation template using `=.id=<resolvedId>`. */
  readonly words: readonly string[];
  readonly requiresIdResolution?: boolean;
  readonly previewCommand: string;
  readonly rollbackCommand: string;
  readonly riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export function validateAndBuildPlaybook(
  actionType: PlaybookActionType,
  params: Readonly<Record<string, string>>,
  nocServerIp?: string,
): BuiltRouterOsAction {
  if (actionType === 'ADD_FIREWALL_BLOCKLIST') {
    const ip = IPv4Schema.parse(params.ip ?? '');
    if (PROTECTED_MANAGEMENT_IPS.has(ip) || (nocServerIp && ip === nocServerIp)) {
      throw new Error(`Security Guardrail: Blocking protected management IP ${ip} is forbidden`);
    }
    const mgmtPrefix = getManagementPrefix(nocServerIp);
    if (mgmtPrefix && ip.startsWith(mgmtPrefix)) {
      throw new Error(`Security Guardrail: Blocking internal management subnet IP ${ip} is forbidden`);
    }
    const listName = SafeIdentifierSchema.parse(params.list ?? 'AI_NOC_BLOCKLIST');
    const timeout = TimeoutSchema.parse(params.timeout ?? '24h');
    const comment = 'AI-NOC Approved Block';

    return {
      words: [
        '/ip/firewall/address-list/add',
        `=list=${listName}`,
        `=address=${ip}`,
        `=timeout=${timeout}`,
        `=comment=${comment}`,
      ],
      previewCommand: `/ip firewall address-list add list=${listName} address=${ip} timeout=${timeout} comment="${comment}"`,
      rollbackCommand: `/ip firewall address-list remove [find list="${listName}" address="${ip}"]`,
      riskLevel: 'LOW',
    };
  }

  if (actionType === 'RESET_PPPOE_SESSION') {
    const username = SafeIdentifierSchema.parse(params.username ?? '');
    return {
      lookupWords: ['/ppp/active/print', `?name=${username}`],
      words: ['/ppp/active/remove'],
      requiresIdResolution: true,
      previewCommand: `/ppp active remove [find name="${username}"]`,
      rollbackCommand: `# Client PPPoE "${username}" akan redial otomatis dalam beberapa detik`,
      riskLevel: 'LOW',
    };
  }

  if (actionType === 'ENABLE_INTERFACE') {
    const iface = SafeIdentifierSchema.parse(params.interface ?? '');
    return {
      lookupWords: ['/interface/print', `?name=${iface}`],
      words: ['/interface/enable'],
      requiresIdResolution: true,
      previewCommand: `/interface enable "${iface}"`,
      rollbackCommand: `/interface disable "${iface}"`,
      riskLevel: 'MEDIUM',
    };
  }

  if (actionType === 'SWITCH_BACKUP_ROUTE') {
    const commentKey = SafeIdentifierSchema.parse(params.routeComment ?? 'ISP_BACKUP');
    const newDistance = z.string().regex(/^[1-9]\d?$/).parse(params.distance ?? '1');
    return {
      lookupWords: ['/ip/route/print', `?comment=${commentKey}`],
      words: ['/ip/route/set', `=distance=${newDistance}`],
      requiresIdResolution: true,
      previewCommand: `/ip route set [find comment="${commentKey}"] distance=${newDistance}`,
      rollbackCommand: `/ip route set [find comment="${commentKey}"] distance=2`,
      riskLevel: 'HIGH',
    };
  }

  return {
    words: ['/system/resource/print'],
    previewCommand: `/system resource print # Hanya diagnostik, tanpa perubahan konfigurasi`,
    rollbackCommand: `# Tidak ada perubahan`,
    riskLevel: 'LOW',
  };
}

export interface ResolvedWriteCredentials {
  readonly username: string;
  readonly secret: string;
  readonly source: 'router' | 'spv';
}

/**
 * Resolves RouterOS write credentials:
 * 1) Per-router env (`router.execSecretEnv`) if configured
 * 2) Central 1-account SPV NOC write (`SPV_EXEC_USERNAME` + `SPV_EXEC_SECRET`) for all routers
 * Returns null when operating in Read-Only mode.
 */
export function resolveWriteCredentials(router: RouterDevice): ResolvedWriteCredentials | null {
  const perRouterSecret = (process.env[router.execSecretEnv] ?? '').trim();
  if (perRouterSecret) {
    return {
      username: router.execUsername,
      secret: perRouterSecret,
      source: 'router',
    };
  }
  const spvSecret = (process.env.SPV_EXEC_SECRET ?? '').trim();
  if (spvSecret) {
    const spvUser = (process.env.SPV_EXEC_USERNAME ?? '').trim() || 'spv_noc_write';
    return {
      username: spvUser,
      secret: spvSecret,
      source: 'spv',
    };
  }
  return null;
}

export function hasWriteCredentialsForRouter(router: RouterDevice): boolean {
  return resolveWriteCredentials(router) !== null;
}

export async function executeApprovedProposal(
  router: RouterDevice,
  proposal: ActionProposalPayload,
  nocServerIp?: string,
): Promise<string> {
  const built = validateAndBuildPlaybook(proposal.actionType, proposal.parameters, nocServerIp);

  if (router.simulated || proposal.actionType === 'DIAGNOSTIC_ONLY') {
    return `[SIMULATED OK on ${router.name}] Dieksekusi: ${built.previewCommand}`;
  }

  const creds = resolveWriteCredentials(router);
  if (!creds) {
    return `[MODE READ-ONLY — DITANDAI DITANGANI MANUAL] Tidak ada perubahan dikirim ke ${router.name}. Perintah Winbox/CLI: ${built.previewCommand}`;
  }

  const client = new RouterOsClient({
    host: router.host,
    port: router.port,
    useTls: router.useTls,
    username: creds.username,
    secret: creds.secret,
    timeoutMs: 8000,
  });

  await client.withSession(async (run) => {
    if (built.requiresIdResolution && built.lookupWords) {
      const matched = await run(built.lookupWords);
      const ids = matched.map((r) => r['.id']).filter((id): id is string => Boolean(id));
      if (ids.length === 0) {
        throw new Error(`Target tidak ditemukan pada ${router.name} saat lookup ${built.lookupWords.join(' ')}`);
      }
      for (const id of ids) {
        await run([...built.words, `=.id=${id}`]);
      }
      return;
    }
    await run(built.words);
  });

  const actorTag = creds.source === 'spv' ? `SPV Write (${creds.username})` : creds.username;
  return `[EXECUTED OK via ${actorTag} on ${router.name}] ${built.previewCommand}`;
}
