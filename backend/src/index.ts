import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import dotenv from 'dotenv';
import { loadRouterInventory, saveRouterInventory } from './inventory.js';
import { ApprovalGateStore } from './approvalStore.js';
import { NocOrchestrator } from './orchestrator.js';
import { SecretVault } from './secretVault.js';
import { AdminAuthManager } from './auth.js';
import { AntigravityBridgeStore } from './antigravityBridge.js';
import { SyslogUdpServer, parseMikrotikSyslog } from './syslogReceiver.js';
import type { NocSnapshot } from './types.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DecisionBodySchema = z.object({
  actor: z.string().min(1).max(80).default('WebAdmin'),
});

const SimulateIncidentSchema = z.object({
  routerId: z.string().min(1),
  scenario: z.enum(['radius_timeout', 'bruteforce', 'wan_down', 'pppoe_stuck']),
});

const LoginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newUsername: z.string().trim().min(2).max(64).optional(),
  newPassword: z.string().min(6, 'Password baru minimal 6 karakter').max(128),
});

const AskAgentSchema = z.object({
  question: z.string().trim().min(1).max(600),
});

const BridgeReportSchema = z.object({
  routerId: z.string().trim().min(1).max(64),
  briefing: z.string().trim().min(1).max(240),
  detailMessage: z.string().trim().min(1).max(2000),
  agentLabel: z.string().trim().min(1).max(80).optional(),
});

const RouterUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9._:-]+$/, 'Alamat host/IP tidak valid')
    .optional(),
  port: z.number().int().min(1).max(65535).optional(),
  useTls: z.boolean().optional(),
  routerOsVersion: z.enum(['v6', 'v7']).optional(),
  readUsername: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Username MikroTik tidak valid')
    .optional(),
  readPassword: z.string().max(128).optional(),
  clearReadPassword: z.boolean().optional(),
  simulated: z.boolean().optional(),
});

const NewRouterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  deviceModel: z.string().trim().max(80).optional(),
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9._:-]+$/, 'Alamat host/IP tidak valid'),
  port: z.number().int().min(1).max(65535).default(8728),
  useTls: z.boolean().default(false),
  routerOsVersion: z.enum(['v6', 'v7']).default('v7'),
  role: z.enum(['core', 'bras', 'branch']).default('branch'),
  room: z.enum(['core', 'security', 'distribusi']).default('distribusi'),
  agentName: z.string().trim().max(64).optional(),
  readUsername: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Username MikroTik tidak valid')
    .default('noc_readonly'),
  readPassword: z.string().max(128).optional(),
  simulated: z.boolean().default(true),
});

function createWriteRateLimiter(maxPerMinute = 90) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? 'local';
    const now = Date.now();
    const windowStart = now - 60_000;
    const recent = (hits.get(key) ?? []).filter((ts) => ts > windowStart);
    if (recent.length >= maxPerMinute) {
      res.status(429).json({ success: false, error: 'Terlalu banyak permintaan, coba lagi dalam 1 menit' });
      return;
    }
    hits.set(key, [...recent, now]);
    next();
  };
}

function resolveStaticDir(): string | null {
  const candidates = [
    process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : null,
    path.resolve(__dirname, '../../frontend/dist'),
    path.resolve(process.cwd(), '../frontend/dist'),
  ].filter((p): p is string => Boolean(p));

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  return null;
}

export async function createNocServer() {
  const dataDir = process.env.NOC_DATA_DIR ?? path.resolve(process.cwd(), 'data');
  const routersPath = path.join(dataDir, 'routers.json');
  const approvalsPath = path.join(dataDir, 'approvals.json');

  const secretVault = new SecretVault(dataDir);
  await secretVault.init();

  const authManager = new AdminAuthManager(dataDir, secretVault.getSigningMaterial());
  const configuredAdminUser = (process.env.NOC_ADMIN_USER ?? 'admin').trim() || 'admin';
  const configuredAdminPass = (process.env.NOC_ADMIN_PASS ?? '').trim();
  const bootstrapPass = configuredAdminPass || crypto.randomBytes(9).toString('base64url');
  const seededFreshAdmin = await authManager.init(configuredAdminUser, bootstrapPass);
  if (seededFreshAdmin && !configuredAdminPass) {
    console.log(`[AI-NOC] Akun admin awal dibuat -> username: ${configuredAdminUser} | password: ${bootstrapPass}`);
    console.log(`[AI-NOC] Segera ubah password admin melalui menu Akun di Dashboard Web.`);
  }

  const aiBridge = new AntigravityBridgeStore(dataDir);
  await aiBridge.init();

  const routers = await loadRouterInventory(routersPath);
  const approvalStore = new ApprovalGateStore(approvalsPath, 30);
  await approvalStore.init();

  const clients = new Set<WebSocket>();
  const broadcastSnapshot = (snapshot: NocSnapshot) => {
    const payload = JSON.stringify({ type: 'NOC_SNAPSHOT', data: snapshot });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  };

  const orchestrator = new NocOrchestrator({
    routers,
    approvalStore,
    nocServerIp: process.env.NOC_SERVER_IP ?? '192.168.88.10',
    telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
    onBroadcast: broadcastSnapshot,
    onPersistRouters: (nextRouters) => saveRouterInventory(routersPath, nextRouters),
    secretVault,
    aiBridge,
  });

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '64kb' }));

  const adminToken = (process.env.NOC_ADMIN_TOKEN ?? '').trim();
  const writeLimiter = createWriteRateLimiter(90);

  const isAuthorizedRequest = (req: http.IncomingMessage): string | null => {
    const session = authManager.verifyCookieHeader(req.headers.cookie);
    if (session) return session.u;
    if (adminToken) {
      const provided =
        String(req.headers['x-noc-token'] ?? '') ||
        String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(provided);
      const b = Buffer.from(adminToken);
      if (a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b)) {
        return 'api-token';
      }
    }
    return null;
  };

  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const user = isAuthorizedRequest(req);
    if (!user) {
      res.status(401).json({ success: false, error: 'Silakan login sebagai Admin NOC terlebih dahulu' });
      return;
    }
    (req as Request & { nocUser?: string }).nocUser = user;
    next();
  };

  // --- Public health & auth endpoints ---
  app.get('/api/health', (_req, res) => {
    res.json({
      success: true,
      data: {
        status: 'ok',
        authRequired: true,
        routersMonitored: orchestrator.getRouters().length,
        liveRouters: orchestrator.getRouters().filter((r) => !r.simulated).length,
        uptimeSec: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      },
    });
  });

  app.get('/api/auth/me', (req, res) => {
    const user = isAuthorizedRequest(req);
    res.json({
      success: true,
      data: {
        authenticated: Boolean(user),
        username: user ?? null,
      },
    });
  });

  app.post('/api/auth/login', writeLimiter, (req, res) => {
    try {
      const { username, password } = LoginSchema.parse(req.body ?? {});
      const check = authManager.verifyLogin(username, password, req.ip ?? 'local');
      if (!check.ok) {
        res.status(401).json({ success: false, error: check.error ?? 'Login gagal' });
        return;
      }
      const token = authManager.issueSessionToken(authManager.getUsername());
      res.setHeader('Set-Cookie', authManager.buildSetCookieHeader(token));
      res.json({
        success: true,
        data: { authenticated: true, username: authManager.getUsername() },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Format login tidak valid';
      res.status(400).json({ success: false, error: message });
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', authManager.buildClearCookieHeader());
    res.json({ success: true });
  });

  app.post('/api/auth/change-password', writeLimiter, requireAdmin, async (req, res) => {
    try {
      const body = ChangePasswordSchema.parse(req.body ?? {});
      await authManager.changeCredentials(body.currentPassword, body.newUsername ?? authManager.getUsername(), body.newPassword);
      const token = authManager.issueSessionToken(authManager.getUsername());
      res.setHeader('Set-Cookie', authManager.buildSetCookieHeader(token));
      res.json({
        success: true,
        data: { username: authManager.getUsername() },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal mengubah password admin';
      res.status(400).json({ success: false, error: message });
    }
  });

  // --- Protected NOC API endpoints ---
  app.get('/api/snapshot', requireAdmin, (_req, res) => {
    res.json({
      success: true,
      data: orchestrator.buildSnapshot(),
    });
  });

  app.get('/api/routers', requireAdmin, (_req, res) => {
    res.json({
      success: true,
      data: orchestrator.getPublicRouters(),
    });
  });

  app.get('/api/approvals', requireAdmin, (_req, res) => {
    res.json({
      success: true,
      data: orchestrator.getApprovals(),
    });
  });

  app.get('/api/logs', requireAdmin, (_req, res) => {
    res.json({
      success: true,
      data: orchestrator.getGlobalLogs(),
    });
  });

  app.post('/api/poll-now', writeLimiter, requireAdmin, async (_req, res) => {
    try {
      await orchestrator.pollAllRouters();
      res.json({ success: true, data: orchestrator.buildSnapshot() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal menjalankan poll';
      res.status(500).json({ success: false, error: message });
    }
  });

  app.post('/api/routers', writeLimiter, requireAdmin, async (req, res) => {
    try {
      const input = NewRouterSchema.parse(req.body ?? {});
      const created = await orchestrator.addRouter(input);
      res.status(201).json({
        success: true,
        data: {
          routerId: created.id,
          snapshot: orchestrator.buildSnapshot(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal menambahkan router';
      res.status(400).json({ success: false, error: message });
    }
  });

  app.put('/api/routers/:id', writeLimiter, requireAdmin, async (req, res) => {
    try {
      const patch = RouterUpdateSchema.parse(req.body ?? {});
      const updated = await orchestrator.updateRouter(String(req.params.id), patch);
      res.json({
        success: true,
        data: {
          routerId: updated.id,
          snapshot: orchestrator.buildSnapshot(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal memperbarui konfigurasi router';
      res.status(400).json({ success: false, error: message });
    }
  });

  app.delete('/api/routers/:id', writeLimiter, requireAdmin, async (req, res) => {
    try {
      await orchestrator.deleteRouter(String(req.params.id));
      res.json({
        success: true,
        data: { snapshot: orchestrator.buildSnapshot() },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal menghapus router';
      res.status(400).json({ success: false, error: message });
    }
  });

  app.post('/api/routers/:id/test', writeLimiter, requireAdmin, async (req, res) => {
    try {
      const override = RouterUpdateSchema.parse(req.body ?? {});
      const telemetry = await orchestrator.testRouterConnection(String(req.params.id), override);
      res.json({ success: true, data: telemetry });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal menguji koneksi router';
      res.status(400).json({ success: false, error: message });
    }
  });

  app.post('/api/approvals/:id/approve', writeLimiter, requireAdmin, async (req, res) => {
    try {
      const body = DecisionBodySchema.parse(req.body ?? {});
      const ticket = await orchestrator.approveAndExecute(String(req.params.id), body.actor);
      res.json({ success: true, data: ticket });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal menyetujui tiket';
      res.status(400).json({ success: false, error: message });
    }
  });

  app.post('/api/approvals/:id/reject', writeLimiter, requireAdmin, async (req, res) => {
    try {
      const body = DecisionBodySchema.parse(req.body ?? {});
      const ticket = await orchestrator.rejectProposal(String(req.params.id), body.actor);
      res.json({ success: true, data: ticket });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal menolak tiket';
      res.status(400).json({ success: false, error: message });
    }
  });

  app.post('/api/agents/:id/ask', writeLimiter, requireAdmin, async (req, res) => {
    try {
      const { question } = AskAgentSchema.parse(req.body ?? {});
      const result = await orchestrator.askAgentAi(String(req.params.id), question);
      res.json({
        success: true,
        data: {
          ...result,
          snapshot: orchestrator.buildSnapshot(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal menghubungi AI agen';
      res.status(400).json({ success: false, error: message });
    }
  });

  app.post('/api/bridge/antigravity/report', writeLimiter, requireAdmin, async (req, res) => {
    try {
      const body = BridgeReportSchema.parse(req.body ?? {});
      await orchestrator.pushAntigravityReport(body.routerId, body.briefing, body.detailMessage, body.agentLabel);
      res.json({
        success: true,
        data: { snapshot: orchestrator.buildSnapshot() },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal mengirim laporan Antigravity Bridge';
      res.status(400).json({ success: false, error: message });
    }
  });

  app.post('/api/simulate-incident', writeLimiter, requireAdmin, async (req, res) => {
    try {
      const { routerId, scenario } = SimulateIncidentSchema.parse(req.body ?? {});
      const router = orchestrator.getRouters().find((r) => r.id === routerId);
      if (!router) {
        res.status(404).json({ success: false, error: 'Router tidak ditemukan' });
        return;
      }

      const rawMessages: Record<typeof scenario, string> = {
        radius_timeout: '<27>pppoe,ppp,error <0fea>: user "pelanggan_momonet01" authentication failed - radius timeout',
        bruteforce: '<34>system,error,critical login failure for user admin from 185.220.101.42 via ssh',
        wan_down: '<27>interface,warning,error sfp-sfpplus1-ISP link down',
        pppoe_stuck: '<28>pppoe,ppp,error <pelanggan_corp_01>: peer is not responding',
      };

      const entry = parseMikrotikSyslog(rawMessages[scenario], router.host, () => router.id);
      await orchestrator.ingestSyslog(entry);
      res.json({ success: true, data: orchestrator.buildSnapshot() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Simulasi gagal';
      res.status(400).json({ success: false, error: message });
    }
  });

  const staticDir = resolveStaticDir();
  if (staticDir) {
    app.use(express.static(staticDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/ws') {
        next();
        return;
      }
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const user = isAuthorizedRequest(req);
    if (!user) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'NOC_SNAPSHOT', data: orchestrator.buildSnapshot() }));
    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  const syslogPort = Number(process.env.SYSLOG_UDP_PORT ?? '5514');
  const syslogServer = new SyslogUdpServer(
    syslogPort,
    (ip, hostname) => orchestrator.resolveRouterIdBySource(ip, hostname),
    (entry) => {
      void orchestrator.ingestSyslog(entry);
    },
  );

  const shutdown = async () => {
    orchestrator.stop();
    for (const ws of clients) {
      ws.close();
    }
    wss.close();
    await syslogServer.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { app, server, wss, orchestrator, syslogServer, syslogPort, staticDir, authManager, shutdown };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const httpPort = Number(process.env.PORT ?? '8090');
  createNocServer()
    .then(async ({ server, orchestrator, syslogServer, syslogPort, staticDir, shutdown }) => {
      await syslogServer.start();
      await orchestrator.start(Number(process.env.POLL_INTERVAL_MS ?? '15000'));
      server.listen(httpPort, '0.0.0.0', () => {
        console.log(`[AI-NOC] HTTP, Web UI & WebSocket server aktif di 0.0.0.0:${httpPort}`);
        console.log(`[AI-NOC] MikroTik Syslog UDP receiver aktif di 0.0.0.0:${syslogPort}`);
        if (staticDir) {
          console.log(`[AI-NOC] Menyajikan Kantor 3D statis dari: ${staticDir}`);
        }
      });

      const handleSignal = (sig: string) => {
        console.log(`[AI-NOC] Menerima ${sig}, menutup layanan secara bersih…`);
        void shutdown().finally(() => process.exit(0));
      };
      process.once('SIGINT', () => handleSignal('SIGINT'));
      process.once('SIGTERM', () => handleSignal('SIGTERM'));
    })
    .catch((err) => {
      console.error('[AI-NOC] Gagal memulai server:', err);
      process.exit(1);
    });
}
