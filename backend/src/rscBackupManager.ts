import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RouterOsSessionPool } from './routerosClient.js';
import type { RscBackupEntry, RscBackupSummary, RouterDevice } from './types.js';

const execFileAsync = promisify(execFile);

interface RscSectionSpec {
  readonly cliPath: string;
  readonly apiPath: string;
  readonly singleton?: boolean;
  readonly v7Only?: boolean;
  readonly v6Only?: boolean;
}

const RSC_SECTIONS: readonly RscSectionSpec[] = [
  { cliPath: '/system identity', apiPath: '/system/identity/print', singleton: true },
  { cliPath: '/interface bridge', apiPath: '/interface/bridge/print' },
  { cliPath: '/interface ethernet', apiPath: '/interface/ethernet/print' },
  { cliPath: '/interface vlan', apiPath: '/interface/vlan/print' },
  { cliPath: '/interface bridge port', apiPath: '/interface/bridge/port/print' },
  { cliPath: '/ip pool', apiPath: '/ip/pool/print' },
  { cliPath: '/ip address', apiPath: '/ip/address/print' },
  { cliPath: '/ip dhcp-server', apiPath: '/ip/dhcp-server/print' },
  { cliPath: '/ip dhcp-server network', apiPath: '/ip/dhcp-server/network/print' },
  { cliPath: '/ip dns', apiPath: '/ip/dns/print', singleton: true },
  { cliPath: '/ip route', apiPath: '/ip/route/print' },
  { cliPath: '/ppp profile', apiPath: '/ppp/profile/print' },
  { cliPath: '/interface pppoe-server server', apiPath: '/interface/pppoe-server/server/print' },
  { cliPath: '/ip hotspot profile', apiPath: '/ip/hotspot/profile/print' },
  { cliPath: '/ip hotspot', apiPath: '/ip/hotspot/print' },
  { cliPath: '/ip firewall nat', apiPath: '/ip/firewall/nat/print' },
  { cliPath: '/ip firewall filter', apiPath: '/ip/firewall/filter/print' },
  { cliPath: '/ip firewall mangle', apiPath: '/ip/firewall/mangle/print' },
  { cliPath: '/ip firewall raw', apiPath: '/ip/firewall/raw/print' },
  { cliPath: '/routing bgp connection', apiPath: '/routing/bgp/connection/print', v7Only: true },
  { cliPath: '/routing bgp peer', apiPath: '/routing/bgp/peer/print', v6Only: true },
  { cliPath: '/radius', apiPath: '/radius/print' },
  { cliPath: '/system ntp client', apiPath: '/system/ntp/client/print', singleton: true },
  { cliPath: '/system logging action', apiPath: '/system/logging/action/print' },
  { cliPath: '/system logging', apiPath: '/system/logging/print' },
  { cliPath: '/ip service', apiPath: '/ip/service/print' },
];

const VOLATILE_KEYS = new Set([
  '.id',
  '.nextid',
  'bytes',
  'packets',
  'rx-byte',
  'tx-byte',
  'fp-rx-byte',
  'fp-tx-byte',
  'rx-packet',
  'tx-packet',
  'fp-rx-packet',
  'fp-tx-packet',
  'rx-drop',
  'tx-drop',
  'rx-error',
  'tx-error',
  'link-downs',
  'last-link-up-time',
  'last-link-down-time',
  'actual-mtu',
  'running',
  'slave',
  'active',
  'invalid',
  'dynamic',
  'radius',
  'uptime',
  'last-logged-out',
  'mac-address',
  'orig-mac-address',
  'current-distance',
  'immediate-gw',
  'gateway-status',
]);

const SENSITIVE_KEY_PATTERN = /(password|secret|passphrase|private-key|pre-shared-key|auth-key|community)/i;

export function toSafeRscFileName(routerName: string): string {
  const base = routerName
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return `${base || 'mikrotik'}.rsc`;
}

function formatRscValue(val: string): string {
  if (val === '') return '""';
  if (/^[a-zA-Z0-9._:/-]+$/.test(val)) return val;
  const escaped = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
  return `"${escaped}"`;
}

export function buildRscFromSectionRows(
  router: RouterDevice,
  boardInfo: Readonly<Record<string, string>>,
  sections: readonly { readonly cliPath: string; readonly singleton?: boolean; readonly rows: readonly Record<string, string>[] }[],
): string {
  const lines: string[] = [
    `# ====================================================================`,
    `# MIKROTIK AUTO-BACKUP (.rsc) — AI NOC MULTI-MIKROTIK`,
    `# Router   : ${router.name} (${router.id})`,
    `# Host     : ${router.host}:${router.port} (${router.routerOsVersion})`,
    `# Board    : ${boardInfo['board-name'] ?? router.deviceModel ?? 'MikroTik'} · ROS ${boardInfo.version ?? router.routerOsVersion}`,
    `# Mode     : Read-Only Safe Export (Sensitive Secrets Redacted)`,
    `# ====================================================================`,
    '',
  ];

  for (const sec of sections) {
    const staticRows = sec.rows.filter((r) => r.dynamic !== 'true');
    if (staticRows.length === 0) continue;

    lines.push(sec.cliPath);
    for (const row of staticRows) {
      const attrs: string[] = [];
      const sortedKeys = Object.keys(row).sort();
      for (const k of sortedKeys) {
        if (VOLATILE_KEYS.has(k) || k.startsWith('.')) continue;
        const rawVal = row[k];
        if (rawVal === undefined || rawVal === '') continue;
        const safeVal = SENSITIVE_KEY_PATTERN.test(k) ? '<REDACTED>' : rawVal;
        attrs.push(`${k}=${formatRscValue(safeVal)}`);
      }
      if (attrs.length === 0) continue;
      if (sec.singleton) {
        lines.push(`set ${attrs.join(' ')}`);
      } else if (sec.cliPath === '/interface ethernet' || sec.cliPath === '/ip service') {
        const findKey = row.name ?? row.numbers ?? '';
        if (findKey) {
          lines.push(`set [ find default-name=${formatRscValue(findKey)} ] ${attrs.join(' ')}`);
        } else {
          lines.push(`set ${attrs.join(' ')}`);
        }
      } else {
        lines.push(`add ${attrs.join(' ')}`);
      }
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function computeRscDiff(
  previousContent: string | null,
  nextContent: string,
): { readonly addedLines: number; readonly removedLines: number; readonly diffPreview: readonly string[] } {
  if (previousContent === null) {
    const count = nextContent.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
    return {
      addedLines: count,
      removedLines: 0,
      diffPreview: ['Snapshot awal (.rsc pertama kali dibuat)'],
    };
  }
  if (previousContent === nextContent) {
    return { addedLines: 0, removedLines: 0, diffPreview: [] };
  }

  const prevLines = previousContent.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const nextLines = nextContent.split('\n').filter((l) => l.trim() && !l.startsWith('#'));

  const prevCounts = new Map<string, number>();
  for (const l of prevLines) prevCounts.set(l, (prevCounts.get(l) ?? 0) + 1);

  const nextCounts = new Map<string, number>();
  for (const l of nextLines) nextCounts.set(l, (nextCounts.get(l) ?? 0) + 1);

  let addedLines = 0;
  let removedLines = 0;
  const preview: string[] = [];

  for (const [line, cnt] of nextCounts) {
    const prevCnt = prevCounts.get(line) ?? 0;
    if (cnt > prevCnt) {
      const delta = cnt - prevCnt;
      addedLines += delta;
      if (preview.length < 10) preview.push(`+ ${line.slice(0, 120)}`);
    }
  }
  for (const [line, cnt] of prevCounts) {
    const nextCnt = nextCounts.get(line) ?? 0;
    if (cnt > nextCnt) {
      const delta = cnt - nextCnt;
      removedLines += delta;
      if (preview.length < 10) preview.push(`- ${line.slice(0, 120)}`);
    }
  }

  return { addedLines, removedLines, diffPreview: preview };
}

interface PersistedRscIndex {
  readonly lastRunAt: string | null;
  readonly lastRunDate?: string;
  readonly lastGitSyncAt: string | null;
  readonly lastGitSyncStatus: string;
  readonly entries: readonly RscBackupEntry[];
}

/**
 * Stores MikroTik `.rsc` files in a SEPARATE dedicated directory (`<rootDir>/mikrotik-rsc/`)
 * with `latest/<RouterName>.rsc` and `history/<YYYY-MM-DD>/<RouterName>.rsc`,
 * plus optional automatic push to the user's PRIVATE GitHub backup repository!
 */
export class RscBackupManager {
  private readonly rscDir: string;
  private readonly latestDir: string;
  private readonly historyDir: string;
  private readonly indexPath: string;
  private readonly appDataDir: string;
  private readonly privateBackupRepoDir: string;
  private state: PersistedRscIndex = {
    lastRunAt: null,
    lastGitSyncAt: null,
    lastGitSyncStatus: 'Belum disinkronkan',
    entries: [],
  };
  private running = false;

  constructor(options: {
    readonly rscRootDir: string;
    readonly appDataDir: string;
    readonly privateBackupRepoDir?: string;
  }) {
    this.rscDir = options.rscRootDir;
    this.latestDir = path.join(this.rscDir, 'latest');
    this.historyDir = path.join(this.rscDir, 'history');
    this.indexPath = path.join(this.rscDir, 'index.json');
    this.appDataDir = options.appDataDir;
    this.privateBackupRepoDir =
      options.privateBackupRepoDir ??
      process.env.PRIVATE_BACKUP_REPO_DIR ??
      path.resolve(this.rscDir, '../../ai-noc-backup');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.latestDir, { recursive: true });
    await fs.mkdir(this.historyDir, { recursive: true });
    const readmePath = path.join(this.rscDir, 'README.md');
    try {
      await fs.access(readmePath);
    } catch {
      await fs.writeFile(
        readmePath,
        [
          '# Folder Khusus Backup MikroTik (.rsc)',
          '',
          '- `latest/` : File `.rsc` konfigurasi TERBARU dari masing-masing router MikroTik (siap dicari & di-download cepat).',
          '- `history/YYYY-MM-DD/` : Arsip harian konfigurasi `.rsc` (otomatis disimpan maks. 30 hari terakhir).',
          '- `index.json` : Ringkasan waktu backup & perubahan baris konfigurasi (Config Diff).',
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o600 },
      );
    }

    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedRscIndex>;
      this.state = {
        lastRunAt: typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : null,
        lastRunDate: typeof parsed.lastRunDate === 'string' ? parsed.lastRunDate : undefined,
        lastGitSyncAt: typeof parsed.lastGitSyncAt === 'string' ? parsed.lastGitSyncAt : null,
        lastGitSyncStatus: typeof parsed.lastGitSyncStatus === 'string' ? parsed.lastGitSyncStatus : 'Siap',
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch {
      await this.persistIndex();
    }
  }

  getSummary(): RscBackupSummary {
    return {
      folderName: 'mikrotik-rsc',
      lastRunAt: this.state.lastRunAt,
      lastGitSyncAt: this.state.lastGitSyncAt,
      lastGitSyncStatus: this.state.lastGitSyncStatus,
      entries: this.state.entries,
    };
  }

  shouldRunDailyBackup(now = new Date(), targetHour = 2): boolean {
    if (this.running) return false;
    if (this.state.entries.length === 0) return true;
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const todayKey = `${yyyy}-${mm}-${dd}`;
    if (this.state.lastRunDate === todayKey) return false;
    return now.getHours() >= targetHour;
  }

  async readRouterRscContent(fileName: string): Promise<string | null> {
    const clean = path.basename(fileName);
    if (!clean.endsWith('.rsc') || clean !== fileName) return null;
    try {
      return await fs.readFile(path.join(this.latestDir, clean), 'utf8');
    } catch {
      return null;
    }
  }

  async backupAllRouters(params: {
    readonly routers: readonly RouterDevice[];
    readonly resolveSecret: (router: RouterDevice) => string;
    readonly pool: RouterOsSessionPool;
    readonly syncGit?: boolean;
  }): Promise<RscBackupSummary> {
    if (this.running) return this.getSummary();
    this.running = true;

    try {
      const now = new Date();
      const dateFolder = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const dayHistoryDir = path.join(this.historyDir, dateFolder);
      await fs.mkdir(dayHistoryDir, { recursive: true });

      const liveRouters = params.routers.filter((r) => !r.simulated);
      const prevById = new Map(this.state.entries.map((e) => [e.routerId, e]));

      const rawResults = await Promise.all(
        liveRouters.map(async (router): Promise<RscBackupEntry | null> => {
          const fileName = toSafeRscFileName(router.name);
          const latestFile = path.join(this.latestDir, fileName);
          const secret = params.resolveSecret(router);

          if (!secret) {
            return prevById.get(router.id) ?? null;
          }

          try {
            const activeSpecs = RSC_SECTIONS.filter((s) =>
              router.routerOsVersion === 'v7' ? !s.v6Only : !s.v7Only,
            );
            const commands: string[][] = [['/system/resource/print'], ...activeSpecs.map((s) => [s.apiPath])];
            const outcomes = await params.pool.runTolerant(
              router.id,
              {
                host: router.host,
                port: router.port,
                useTls: router.useTls,
                username: router.readUsername,
                secret,
                timeoutMs: 5500,
              },
              commands,
            );

            const resOut = outcomes[0];
            if (!resOut?.ok) {
              throw new Error(resOut?.error ?? 'Router tidak merespons');
            }
            const boardInfo = resOut.rows[0] ?? {};
            const sectionData = activeSpecs.map((spec, idx) => ({
              cliPath: spec.cliPath,
              singleton: spec.singleton,
              rows: outcomes[idx + 1]?.ok ? outcomes[idx + 1]!.rows : [],
            }));

            const rscContent = buildRscFromSectionRows(router, boardInfo, sectionData);
            let previousContent: string | null = null;
            try {
              previousContent = await fs.readFile(latestFile, 'utf8');
            } catch {
              previousContent = null;
            }

            const diff = computeRscDiff(previousContent, rscContent);
            await fs.writeFile(latestFile, rscContent, { encoding: 'utf8', mode: 0o600 });
            await fs.writeFile(path.join(dayHistoryDir, fileName), rscContent, { encoding: 'utf8', mode: 0o600 });

            return {
              routerId: router.id,
              routerName: router.name,
              fileName,
              folderPath: `mikrotik-rsc/latest/${fileName}`,
              lastBackupAt: now.toISOString(),
              sizeBytes: Buffer.byteLength(rscContent, 'utf8'),
              lineCount: rscContent.split('\n').length,
              addedLines: diff.addedLines,
              removedLines: diff.removedLines,
              diffPreview: diff.diffPreview,
              status: previousContent !== null && diff.addedLines === 0 && diff.removedLines === 0 ? 'unchanged' : 'ok',
            };
          } catch (err) {
            const prev = prevById.get(router.id);
            return {
              routerId: router.id,
              routerName: router.name,
              fileName,
              folderPath: `mikrotik-rsc/latest/${fileName}`,
              lastBackupAt: prev?.lastBackupAt ?? now.toISOString(),
              sizeBytes: prev?.sizeBytes ?? 0,
              lineCount: prev?.lineCount ?? 0,
              addedLines: 0,
              removedLines: 0,
              diffPreview: prev?.diffPreview ?? [],
              status: 'error',
              error: err instanceof Error ? err.message : 'Gagal menarik konfigurasi',
            };
          }
        }),
      );

      const nextEntries: RscBackupEntry[] = rawResults.filter((e): e is RscBackupEntry => e !== null);

      await this.pruneOldHistoryDirs(30);

      let gitSyncAt = this.state.lastGitSyncAt;
      let gitSyncStatus = this.state.lastGitSyncStatus;
      if (params.syncGit !== false) {
        const syncRes = await this.syncToPrivateGitHub();
        if (syncRes.synced) {
          gitSyncAt = new Date().toISOString();
        }
        gitSyncStatus = syncRes.detail;
      }

      this.state = {
        lastRunAt: now.toISOString(),
        lastRunDate: dateFolder,
        lastGitSyncAt: gitSyncAt,
        lastGitSyncStatus: gitSyncStatus,
        entries: nextEntries,
      };
      await this.persistIndex();
      return this.getSummary();
    } finally {
      this.running = false;
    }
  }

  private async pruneOldHistoryDirs(keepDays: number): Promise<void> {
    try {
      const dirs = (await fs.readdir(this.historyDir)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      if (dirs.length <= keepDays) return;
      const toRemove = dirs.slice(0, dirs.length - keepDays);
      for (const oldDir of toRemove) {
        await fs.rm(path.join(this.historyDir, oldDir), { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  private async syncToPrivateGitHub(): Promise<{ readonly synced: boolean; readonly detail: string }> {
    try {
      await fs.access(path.join(this.privateBackupRepoDir, '.git'));
    } catch {
      return { synced: false, detail: 'Lokal di mikrotik-rsc/ (clone ~/ai-noc-backup belum dipasang)' };
    }

    try {
      const targetRscDir = path.join(this.privateBackupRepoDir, 'mikrotik-rsc');
      const targetDataDir = path.join(this.privateBackupRepoDir, 'server-backup', 'data');
      await fs.mkdir(targetRscDir, { recursive: true });
      await fs.mkdir(targetDataDir, { recursive: true });

      // Sync separate mikrotik-rsc/ folder AND latest NOC data/ files to the PRIVATE backup repo
      await fs.cp(this.rscDir, targetRscDir, { recursive: true, force: true });
      await fs.cp(this.appDataDir, targetDataDir, { recursive: true, force: true });

      await execFileAsync('git', ['add', 'mikrotik-rsc', 'server-backup/data'], { cwd: this.privateBackupRepoDir });
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: this.privateBackupRepoDir,
      });
      if (!statusOut.trim()) {
        return { synced: true, detail: 'Tersinkron ke GitHub Private (tidak ada perubahan baru)' };
      }

      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      await execFileAsync('git', ['commit', '-m', `backup(rsc): auto-sync mikrotik-rsc/ & NOC data (${stamp} UTC)`], {
        cwd: this.privateBackupRepoDir,
      });
      await execFileAsync('git', ['push', 'origin', 'main'], {
        cwd: this.privateBackupRepoDir,
        timeout: 25_000,
      });
      return { synced: true, detail: 'Tersinkron otomatis ke GitHub Private (folder mikrotik-rsc/)' };
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : 'git push gagal';
      return { synced: false, detail: `Tersimpan lokal di mikrotik-rsc/ (Git sync tertunda: ${msg})` };
    }
  }

  private async persistIndex(): Promise<void> {
    const tmp = `${this.indexPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.indexPath);
  }
}
