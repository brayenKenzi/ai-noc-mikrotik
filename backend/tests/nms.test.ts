import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NmsClient } from '../src/nmsClient.js';
import { NmsToolSuite, detectNmsChatIntent } from '../src/nmsTools.js';

interface RecordedReq {
  readonly method: string;
  readonly url: string;
  readonly contentType: string | undefined;
  readonly origin: string | undefined;
  readonly cookie: string | undefined;
  readonly body: unknown;
}

async function startMockNmsServer() {
  let activeToken = 'a'.repeat(64);
  let loginCount = 0;
  let oltsFetchCount = 0;
  let forceNext401 = false;
  const recorded: RecordedReq[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const parsedBody = rawBody ? JSON.parse(rawBody) : null;
      const contentType = req.headers['content-type'];
      const origin = req.headers['origin'];
      const cookie = req.headers['cookie'];
      const url = req.url ?? '/';

      recorded.push({
        method: req.method ?? 'GET',
        url,
        contentType,
        origin,
        cookie,
        body: parsedBody,
      });

      // Enforce exact Content-Type: application/json on ALL POST requests (reject charset suffix with 400!)
      if (req.method === 'POST' && contentType !== 'application/json') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Content-Type must be exact application/json' }));
        return;
      }

      if (req.method === 'POST' && url === '/api/login') {
        loginCount += 1;
        activeToken = loginCount === 1 ? 'a'.repeat(64) : 'b'.repeat(64);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `momo_session=${activeToken}; Path=/; HttpOnly`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (forceNext401 || cookie !== `momo_session=${activeToken}`) {
        forceNext401 = false;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      const expectedOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      if (req.method === 'GET' && url === '/api/olts') {
        oltsFetchCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              name: 'OLT-Mongkonai-01',
              host: '10.10.20.2',
              liveOk: true,
              error: null,
              rows: [
                {
                  index: '0/1:12',
                  name: 'Budi_Mongkonai',
                  mac: 'AA:BB:CC:11:22:33',
                  status: 'Online',
                  rx: -18.4,
                  rxDrop: false,
                  pppoe: {
                    username: 'budi_pppoe',
                    address: '10.50.1.12',
                    uptime: '3d2h',
                    txBps: 12_500_000,
                    rxBps: 2_400_000,
                    txGB: 45.2,
                    rxGB: 8.1,
                    routerName: 'CCR-Pusat-MomoNet',
                  },
                },
                {
                  index: '0/1:15',
                  name: 'Siti_Lolan',
                  mac: 'DD:EE:FF:44:55:66',
                  status: 'Offline',
                  rx: -29.5,
                  rxDrop: true,
                  pppoe: null,
                },
              ],
            },
          ]),
        );
        return;
      }

      if (req.method === 'GET' && url === '/api/alarms') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              id: 1,
              key: 'pon:10.10.20.2:0/2',
              at: '2026-11-25T10:00:00Z',
              until: null,
              kind: 'pon_mass_offline',
              title: 'PON 0/2 OLT-Mongkonai-01 Mass Offline',
              detail: '18 ONU offline bersamaan',
            },
            {
              id: 2,
              key: 'onu:resolved',
              at: '2026-11-24T08:00:00Z',
              until: '2026-11-24T08:15:00Z',
              kind: 'onu_offline',
              title: 'Resolved Alarm',
              detail: 'Pulih',
            },
          ]),
        );
        return;
      }

      if (req.method === 'GET' && url.startsWith('/api/genieacs/device?')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'ZTE F609',
            serial: 'ZTEGC1234567',
            ssid: 'MomoNet-Budi',
            clients: [
              { hostname: 'iPhone-Budi', ip: '192.168.1.10', mac: '11:22:33:44:55:66', rssi: -54 },
              { hostname: 'SmartTV', ip: '192.168.1.11', mac: '11:22:33:44:55:77', rssi: -62 },
            ],
          }),
        );
        return;
      }

      if (req.method === 'POST' && (url === '/api/onu/restart' || url === '/api/genieacs/wifi')) {
        if (origin !== expectedOrigin) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'CSRF Origin mismatch' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, received: parsedBody }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    recorded,
    getLoginCount: () => loginCount,
    getOltsFetchCount: () => oltsFetchCount,
    triggerNext401: () => {
      forceNext401 = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('ADT Monitoring NMS Client & Human-Confirmed AI Tool Suite (Mock HTTP)', () => {
  it('handles cookie login, exact Content-Type, 401 auto-relogin, OLT cache, GenieACS Wi-Fi & 2-step confirmation guardrails', async () => {
    const mock = await startMockNmsServer();
    try {
      const client = new NmsClient({
        baseUrl: mock.baseUrl,
        username: 'noc',
        password: 'mock-test-password',
        oltsCacheTtlMs: 12_000,
      });
      const tools = new NmsToolSuite(client);

      // 1. cek_pelanggan -> logs in once, caches /api/olts across 2 consecutive searches
      const cust1 = await tools.cekPelanggan('budi_pppoe');
      assert.equal(cust1.items.length, 1);
      assert.equal(cust1.items[0]?.rxDbm, -18.4);
      assert.equal(cust1.items[0]?.txMbps, 12.5);
      assert.ok(cust1.formattedText.includes('MomoNet-Budi'));
      assert.ok(!cust1.formattedText.includes('*'));

      const cust2 = await tools.cekPelanggan('AA:BB:CC:11:22:33');
      assert.equal(cust2.items.length, 1);
      assert.equal(mock.getLoginCount(), 1);
      assert.equal(mock.getOltsFetchCount(), 1); // Cache hit!

      // 2. Auto-relogin on HTTP 401
      mock.triggerNext401();
      const health = await tools.cekGangguanJaringan();
      assert.equal(mock.getLoginCount(), 2);
      assert.equal(health.summary.activeAlarmsCount, 1);
      assert.equal(health.summary.onlineOnus, 1);
      assert.equal(health.summary.offlineOnus, 1);
      assert.ok(health.formattedText.includes('PON 0/2 OLT-Mongkonai-01 Mass Offline'));

      // 3. cek_perangkat_wifi -> summon=1 GenieACS device list
      const wifi = await tools.cekPerangkatWifi('budi');
      assert.equal(wifi.parsed.ssid, 'MomoNet-Budi');
      assert.equal(wifi.parsed.devices.length, 2);
      assert.ok(wifi.formattedText.includes('iPhone-Budi'));

      // 4. reboot_modem -> MUST verify first, MUST NOT send action="reboot" until explicitly confirmed!
      const reqReboot = await tools.requestRebootModem('budi_pppoe', 'Boss');
      assert.ok(reqReboot.pendingAction);
      const rebootReqsBeforeConfirm = mock.recorded.filter((r) => r.url === '/api/onu/restart');
      assert.equal(rebootReqsBeforeConfirm.length, 1);
      assert.equal((rebootReqsBeforeConfirm[0]?.body as { action?: string }).action, 'verify');
      assert.equal(rebootReqsBeforeConfirm[0]?.origin, mock.baseUrl);
      assert.equal(rebootReqsBeforeConfirm[0]?.contentType, 'application/json');

      // Explicit confirmation executes action="reboot"
      const execReboot = await tools.confirmPendingAction(reqReboot.pendingAction!.id, 'Boss');
      assert.equal(execReboot.ok, true);
      const rebootReqsAfterConfirm = mock.recorded.filter((r) => r.url === '/api/onu/restart');
      assert.equal(rebootReqsAfterConfirm.length, 2);
      assert.equal((rebootReqsAfterConfirm[1]?.body as { action?: string }).action, 'reboot');

      // 5. ubah_wifi_pelanggan -> enforces validation (password >= 8) & requires explicit confirmation
      await assert.rejects(() =>
        tools.requestUbahWifi({ query: 'budi_pppoe', ssid: 'Baru', password: '123' }),
      );
      const reqWifi = await tools.requestUbahWifi({
        query: 'budi_pppoe',
        ssid: 'Rumah-Budi-5G',
        password: 'passwordbaru123',
        requestedBy: 'Boss',
      });
      assert.ok(reqWifi.pendingAction);
      assert.equal(mock.recorded.filter((r) => r.url === '/api/genieacs/wifi').length, 0);

      const execWifi = await tools.confirmPendingAction(reqWifi.pendingAction!.id, 'Boss');
      assert.equal(execWifi.ok, true);
      const wifiReqs = mock.recorded.filter((r) => r.url === '/api/genieacs/wifi');
      assert.equal(wifiReqs.length, 1);
      assert.equal(wifiReqs[0]?.origin, mock.baseUrl);
      assert.equal(wifiReqs[0]?.contentType, 'application/json');

      // 6. Chat intent parser
      assert.deepEqual(detectNmsChatIntent('/olt'), { tool: 'cek_gangguan_jaringan' });
      assert.deepEqual(detectNmsChatIntent('/wifi budi_pppoe'), { tool: 'cek_perangkat_wifi', query: 'budi_pppoe' });
      assert.deepEqual(detectNmsChatIntent('/reboot_modem budi_pppoe'), { tool: 'reboot_modem', query: 'budi_pppoe' });
      assert.deepEqual(detectNmsChatIntent('/ubah_wifi budi_pppoe | BudiHome | rahasia123'), {
        tool: 'ubah_wifi_pelanggan',
        query: 'budi_pppoe',
        ssid: 'BudiHome',
        password: 'rahasia123',
      });
      assert.deepEqual(detectNmsChatIntent('/konfirmasi NMS-1234AB'), {
        tool: 'confirm_action',
        actionId: 'NMS-1234AB',
      });
    } finally {
      await mock.close();
    }
  });
});
