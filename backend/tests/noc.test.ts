import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  encodeLength,
  encodeSentence,
  decodeWordsFromBuffer,
  parseSentenceAttributes,
  evaluateLoginReply,
} from '../src/routerosClient.js';
import {
  parseMikrotikSyslog,
  isAnomalySyslog,
  parseRadiusTimeoutUser,
  parseHotspotFailedLogin,
} from '../src/syslogReceiver.js';
import { parsePingOutput, parseRouterOsPingRows, parseRouterOsRttMs } from '../src/pingMonitor.js';
import { FonnteWhatsappNotifier } from '../src/fonnteNotifier.js';
import { LinkWatchdogEngine, resolveRouterDutyProfile } from '../src/linkWatchdog.js';
import { TopologyStore } from '../src/topologyStore.js';
import { PppoeMassDisconnectWatchdog } from '../src/pppoeWatchdog.js';
import { AiMemoryStore, detectTeachingFact } from '../src/aiMemoryStore.js';
import { SfpOpticalWatchdog, parseSfpMonitorRow } from '../src/sfpMonitor.js';
import {
  extractCustomerLookupQuery,
  formatCustomerLookupPlainText,
  matchSessionRows,
} from '../src/customerLookup.js';
import {
  buildRscFromSectionRows,
  computeRscDiff,
  toSafeRscFileName,
} from '../src/rscBackupManager.js';
import { TrafficPatternLearner } from '../src/trafficPatternLearner.js';
import {
  composeSpvExecutiveReport,
  composeSpvVerifiedIncidentReport,
} from '../src/spvReportComposer.js';
import {
  executeApprovedProposal,
  hasWriteCredentialsForRouter,
  resolveWriteCredentials,
  validateAndBuildPlaybook,
} from '../src/playbooks.js';
import { ApprovalGateStore } from '../src/approvalStore.js';
import { deterministicDiagnosis } from '../src/aiAgent.js';
import { DEFAULT_ROUTERS, loadRouterInventory, saveRouterInventory } from '../src/inventory.js';
import {
  computeHealthStatus,
  computeDeltaMbps,
  parseSystemHealth,
  parsePppActiveCount,
  parseBgpPeerStats,
  sortInterfaces,
  isDynamicSubscriberInterface,
  parseRouterApiLogs,
} from '../src/poller.js';
import { NocOrchestrator } from '../src/orchestrator.js';
import { SecretVault } from '../src/secretVault.js';
import { AdminAuthManager } from '../src/auth.js';
import {
  AntigravityBridgeStore,
  buildDeterministicLiveReply,
  buildDeterministicSpvReply,
  buildSpvWhatsappSummary,
  sanitizePlainAiText,
} from '../src/antigravityBridge.js';

describe('RouterOS v6/v7 Binary Protocol Codec & Auth Evaluation', () => {
  it('encodes and decodes sentences round-trip accurately', () => {
    const s1 = ['/system/resource/print'];
    const s2 = ['!re', '=cpu-load=34', '=board-name=CCR2116-12G-4S+', '=version=7.16.1'];
    const buf = Buffer.concat([encodeSentence(s1), encodeSentence(s2)]);
    const decoded = decodeWordsFromBuffer(buf);

    assert.equal(decoded.sentences.length, 2);
    assert.deepEqual(decoded.sentences[0], s1);
    assert.deepEqual(decoded.sentences[1], s2);
    assert.equal(decoded.remaining.length, 0);

    const attrs = parseSentenceAttributes(decoded.sentences[1]!);
    assert.equal(attrs['cpu-load'], '34');
    assert.equal(attrs['board-name'], 'CCR2116-12G-4S+');
  });

  it('encodes multi-byte lengths properly', () => {
    assert.equal(encodeLength(10).length, 1);
    assert.equal(encodeLength(250).length, 2);
    assert.equal(encodeLength(20000).length, 3);
  });

  it('detects !trap authentication failure even when !done follows', () => {
    const failedReply = [['!trap', '=message=invalid user name or password (6)'], ['!done']];
    const evalRes = evaluateLoginReply(failedReply);
    assert.equal(evalRes.status, 'error');
    assert.ok(evalRes.errorMessage?.includes('invalid user name or password'));

    const challengeReply = [['!done', '=ret=0123456789abcdef0123456789abcdef']];
    const evalChal = evaluateLoginReply(challengeReply);
    assert.equal(evalChal.status, 'challenge');
    assert.equal(evalChal.challengeHex, '0123456789abcdef0123456789abcdef');

    assert.equal(evaluateLoginReply([['!done']]).status, 'ok');
  });
});

describe('9-Router Fleet Inventory, CRUD & Telemetry History', () => {
  it('defines all 9 MikroTik devices including CORE MONGKONAI with noc_readonly user', () => {
    assert.equal(DEFAULT_ROUTERS.length, 9);
    assert.equal(DEFAULT_ROUTERS.filter((r) => r.name.startsWith('CRS-Backbone')).length, 4);
    assert.ok(DEFAULT_ROUTERS.some((r) => r.id === 'core-mongkonai' && r.name === 'CORE MONGKONAI' && r.role === 'core'));
    assert.ok(DEFAULT_ROUTERS.some((r) => r.id === 'ccr-momonet-pusat' && r.routerOsVersion === 'v7'));
    assert.ok(DEFAULT_ROUTERS.some((r) => r.id === 'rb750-qairen' && r.routerOsVersion === 'v6'));
    assert.ok(DEFAULT_ROUTERS.some((r) => r.id === 'rb750-dn-bangomolunow' && r.routerOsVersion === 'v6'));
    assert.ok(DEFAULT_ROUTERS.some((r) => r.id === 'rb750-dn-lolan' && r.routerOsVersion === 'v6'));
    for (const r of DEFAULT_ROUTERS) {
      assert.equal(r.readUsername, 'noc_readonly');
    }
  });

  it('supports update, add, delete, telemetry history, and safe unmatched syslog handling', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'noc-inv-test-'));
    const invPath = path.join(tmpDir, 'routers.json');
    const approvalsPath = path.join(tmpDir, 'approvals.json');

    const routers = await loadRouterInventory(invPath);
    const store = new ApprovalGateStore(approvalsPath, 30);
    await store.init();

    const orchestrator = new NocOrchestrator({
      routers,
      approvalStore: store,
      nocServerIp: '192.168.88.10',
      telegramToken: '',
      telegramChatId: '',
      onBroadcast: () => {},
      onPersistRouters: (next) => saveRouterInventory(invPath, next),
    });

    // Unmatched IP must NOT falsely map to CRS-Backbone-01
    assert.equal(orchestrator.resolveRouterIdBySource('192.0.2.99'), 'unmatched');

    // Update existing router
    const updated = await orchestrator.updateRouter('rb750-qairen', {
      host: '192.168.88.55',
      port: 8728,
      simulated: true,
    });
    assert.equal(updated.host, '192.168.88.55');

    // Add a 10th router dynamically
    const added = await orchestrator.addRouter({
      name: 'RB750-POP-Timur',
      host: '192.168.88.30',
      port: 8728,
      useTls: false,
      routerOsVersion: 'v6',
      role: 'branch',
      room: 'distribusi',
      readUsername: 'noc_readonly',
      simulated: true,
    });
    assert.equal(orchestrator.getRouters().length, 10);

    // Poll twice and confirm telemetry history is recorded
    await orchestrator.pollAllRouters();
    await orchestrator.pollAllRouters();
    const snap = orchestrator.buildSnapshot();
    const addedAgent = snap.agents.find((a) => a.routerId === added.id);
    assert.ok(addedAgent && addedAgent.telemetryHistory.length >= 2);

    // Delete newly added router
    await orchestrator.deleteRouter(added.id);
    assert.equal(orchestrator.getRouters().length, 9);

    const reloaded = await loadRouterInventory(invPath);
    assert.equal(reloaded.length, 9);
    assert.equal(reloaded.find((r) => r.id === 'rb750-qairen')?.host, '192.168.88.55');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

describe('RouterOS v6 & v7 Telemetry Parsers & Interface Sorting', () => {
  it('parses system health for RouterOS v7 key-value rows', () => {
    const res = parseSystemHealth([
      { name: 'voltage', value: '24.3', type: 'V' },
      { name: 'cpu-temperature', value: '51', type: 'C' },
      { name: 'temperature', value: '44', type: 'C' },
    ]);
    assert.equal(res.voltageV, 24.3);
    assert.equal(res.temperatureC, 44);
  });

  it('parses system health for RouterOS v6 flat row', () => {
    const res = parseSystemHealth([{ voltage: '23.8', temperature: '39' }]);
    assert.equal(res.voltageV, 23.8);
    assert.equal(res.temperatureC, 39);
  });

  it('computes accurate interface delta Mbps and guards against counter reset', () => {
    assert.equal(computeDeltaMbps(1_000_000, 11_000_000, 10_000), 8);
    assert.equal(computeDeltaMbps(50_000, 10_000, 10_000), 0);
  });

  it('sorts running and high-traffic SFP interfaces ahead of down ports', () => {
    const sorted = sortInterfaces([
      { name: 'ether1', running: false, disabled: false, rxMbps: 0, txMbps: 0 },
      { name: 'ether2', running: true, disabled: false, rxMbps: 12, txMbps: 3 },
      { name: 'sfp-sfpplus1', running: true, disabled: false, rxMbps: 840, txMbps: 220 },
      { name: 'ether3', running: false, disabled: true, rxMbps: 0, txMbps: 0 },
    ]);
    assert.equal(sorted[0]?.name, 'sfp-sfpplus1');
    assert.equal(sorted[1]?.name, 'ether2');
    assert.equal(sorted[3]?.name, 'ether3');

    assert.equal(isDynamicSubscriberInterface({ name: '<pppoe-A3>', dynamic: 'false' }), true);
    assert.equal(isDynamicSubscriberInterface({ name: 'ether1-WAN', dynamic: 'false' }), false);
    assert.equal(isDynamicSubscriberInterface({ name: 'bridge-local', dynamic: 'true' }), true);
  });

  it('encrypts and decrypts GUI router passwords safely via SecretVault', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'noc-vault-test-'));
    const vault = new SecretVault(tmpDir);
    await vault.init();

    const enc = vault.encrypt('RahasiaMikrotik#2026');
    assert.ok(enc.startsWith('enc:v1:'));
    assert.ok(!enc.includes('RahasiaMikrotik'));
    assert.equal(vault.decrypt(enc), 'RahasiaMikrotik#2026');

    // Reloading vault from same key file must decrypt identically
    const vault2 = new SecretVault(tmpDir);
    await vault2.init();
    assert.equal(vault2.decrypt(enc), 'RahasiaMikrotik#2026');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('parses PPPoE active count and BGP peer stats cleanly', () => {
    assert.equal(parsePppActiveCount({ ok: true, rows: [], doneAttrs: { ret: '412' } }), 412);
    assert.equal(parsePppActiveCount({ ok: false, rows: [], doneAttrs: {}, error: 'no such command' }), 0);

    const stats = parseBgpPeerStats({
      ok: true,
      doneAttrs: {},
      rows: [
        { name: 'isp-1', established: 'true' },
        { name: 'isp-2', state: 'established' },
        { name: 'isp-3', state: 'idle' },
      ],
    });
    assert.deepEqual(stats, { established: 2, total: 3 });
  });
});

describe('MikroTik Syslog Receiver Parser & Anomaly Detection', () => {
  it('parses RFC3164 critical login failure and marks as anomaly', () => {
    const raw =
      '<34>Nov 24 08:40:12 CCR-Pusat-MomoNet system,error,critical login failure for user admin from 185.220.101.9 via ssh';
    const parsed = parseMikrotikSyslog(raw, '192.168.88.1', () => 'ccr-momonet-pusat');

    assert.equal(parsed.routerId, 'ccr-momonet-pusat');
    assert.equal(parsed.severity, 'critical');
    assert.ok(parsed.topics.includes('system'));
    assert.ok(isAnomalySyslog(parsed));
  });

  it('ignores normal informational dhcp logs as non-anomaly', () => {
    const raw = '<30>dhcp,info dhcp1 assigned 192.168.88.54 to AA:BB:CC:DD:EE:FF';
    const parsed = parseMikrotikSyslog(raw, '192.168.88.21', () => 'rb750-qairen');
    assert.equal(parsed.severity, 'info');
    assert.equal(isAnomalySyslog(parsed), false);
  });
});

describe('Anti-Lockout & Playbook 2-Step .id Resolution Guardrails', () => {
  it('builds safe firewall blocklist command for external attacker IPs', () => {
    const res = validateAndBuildPlaybook(
      'ADD_FIREWALL_BLOCKLIST',
      { ip: '185.220.101.9', list: 'AI_NOC_BLOCKLIST', timeout: '24h' },
      '192.168.88.10',
    );
    assert.equal(res.riskLevel, 'LOW');
    assert.ok(res.previewCommand.includes('185.220.101.9'));
    assert.equal(res.requiresIdResolution, undefined);
  });

  it('uses 2-step .id lookup for PPPoE reset, interface enable, and backup route switch', () => {
    const ppp = validateAndBuildPlaybook('RESET_PPPOE_SESSION', { username: 'pelanggan_01' });
    assert.equal(ppp.requiresIdResolution, true);
    assert.deepEqual(ppp.lookupWords, ['/ppp/active/print', '?name=pelanggan_01']);

    const ifc = validateAndBuildPlaybook('ENABLE_INTERFACE', { interface: 'sfp-sfpplus1' });
    assert.equal(ifc.requiresIdResolution, true);
    assert.deepEqual(ifc.lookupWords, ['/interface/print', '?name=sfp-sfpplus1']);

    const rt = validateAndBuildPlaybook('SWITCH_BACKUP_ROUTE', { routeComment: 'ISP_BACKUP', distance: '1' });
    assert.equal(rt.requiresIdResolution, true);
    assert.deepEqual(rt.lookupWords, ['/ip/route/print', '?comment=ISP_BACKUP']);
  });

  it('strictly blocks attempts to firewall the NOC server IP or management subnet', () => {
    assert.throws(() => {
      validateAndBuildPlaybook('ADD_FIREWALL_BLOCKLIST', { ip: '192.168.88.10' }, '192.168.88.10');
    }, /Security Guardrail/);

    assert.throws(() => {
      validateAndBuildPlaybook('ADD_FIREWALL_BLOCKLIST', { ip: '192.168.88.1' }, '192.168.88.10');
    }, /Security Guardrail/);
  });

  it('rejects command injection characters in interface or PPPoE names', () => {
    assert.throws(() => {
      validateAndBuildPlaybook('ENABLE_INTERFACE', { interface: 'ether1; /system reboot' });
    });
  });
});

describe('Human-in-the-Loop Approval Store & Deterministic Agent Diagnosis', () => {
  it('diagnoses brute-force, deduplicates pending tickets, and transitions through approval lifecycle', async () => {
    const tmpFile = path.join(os.tmpdir(), `noc-approvals-test-${Date.now()}.json`);
    const store = new ApprovalGateStore(tmpFile, 30);
    await store.init();

    const router = DEFAULT_ROUTERS[4]!;
    const syslog = parseMikrotikSyslog(
      '<34>system,error,critical login failure for user admin from 45.155.205.233 via winbox',
      router.host,
      () => router.id,
    );

    const diag = deterministicDiagnosis(router, null, [syslog], '192.168.88.10');
    assert.equal(diag.requiresAction, true);
    assert.ok(diag.proposal);
    assert.equal(diag.proposal.actionType, 'ADD_FIREWALL_BLOCKLIST');

    const first = await store.createProposalTicket(router, diag.incidentSummary, diag.rootCauseAnalysis, diag.proposal);
    assert.equal(first.createdNew, true);
    assert.equal(first.ticket.status, 'PENDING');

    const second = await store.createProposalTicket(
      router,
      diag.incidentSummary,
      diag.rootCauseAnalysis,
      diag.proposal,
    );
    assert.equal(second.createdNew, false);
    assert.equal(second.ticket.id, first.ticket.id);

    const approved = await store.approveTicket(first.ticket.id, 'UnitTestAdmin');
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.decidedBy, 'UnitTestAdmin');

    const executed = await store.markExecutionOutcome(first.ticket.id, true, 'Executed cleanly');
    assert.equal(executed.status, 'EXECUTED');

    await fs.rm(tmpFile, { force: true });
  });

  it('evaluates router telemetry health thresholds accurately', () => {
    assert.equal(computeHealthStatus(false, 10, 20, 35), 'offline');
    assert.equal(computeHealthStatus(true, 92, 40, 45), 'critical');
    assert.equal(computeHealthStatus(true, 78, 40, 45), 'warning');
    assert.equal(computeHealthStatus(true, 32, 48, 42), 'healthy');
  });

  it('detects RADIUS timeout format from RouterOS API logs & syslog with highest priority', () => {
    const rawMsg = '<0fea>: user "budi_pppoe" authentication failed - radius timeout';
    assert.equal(parseRadiusTimeoutUser(rawMsg), 'budi_pppoe');

    const router = DEFAULT_ROUTERS[5]!;
    const parsedLogs = parseRouterApiLogs(router, [
      { '.id': '*1A', time: '10:50:12', topics: 'pppoe,ppp,error', message: rawMsg },
    ]);
    assert.equal(parsedLogs.length, 1);
    assert.equal(parsedLogs[0]?.severity, 'critical');
    assert.equal(isAnomalySyslog(parsedLogs[0]!), true);

    const diag = deterministicDiagnosis(router, null, parsedLogs, '192.168.88.10');
    assert.equal(diag.requiresAction, true);
    assert.ok(diag.incidentSummary.includes('RADIUS TIMEOUT'));
    assert.ok(diag.incidentSummary.includes('budi_pppoe'));
  });

  it('handles AdminAuthManager login, session signing, and password change securely', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'noc-auth-test-'));
    const auth = new AdminAuthManager(tmpDir, 'test-signing-key-material');
    await auth.init('admin', 'test-pass-1234');

    assert.equal(auth.verifyLogin('admin', 'salah', '127.0.0.1').ok, false);
    assert.equal(auth.verifyLogin('admin', 'test-pass-1234', '127.0.0.1').ok, true);

    const token = auth.issueSessionToken('admin');
    assert.equal(auth.verifySessionToken(token)?.u, 'admin');
    assert.equal(auth.verifySessionToken(`${token}tampered`), null);

    await auth.changeCredentials('test-pass-1234', 'superadmin', 'baruRahasia99');
    assert.equal(auth.verifyLogin('admin', 'test-pass-1234', '127.0.0.1').ok, false);
    assert.equal(auth.verifyLogin('superadmin', 'baruRahasia99', '127.0.0.1').ok, true);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('links AntigravityBridgeStore to Rangga (ccr-momonet-pusat) and answers live NOC questions', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'noc-bridge-test-'));
    const bridge = new AntigravityBridgeStore(tmpDir);
    await bridge.init();

    const state = bridge.getState('ccr-momonet-pusat');
    assert.equal(state?.linked, true);

    const ccr = DEFAULT_ROUTERS.find((r) => r.id === 'ccr-momonet-pusat')!;
    const tel = {
      routerId: ccr.id,
      timestamp: new Date().toISOString(),
      reachable: true,
      uptime: '1w5d',
      version: '7.18.2',
      boardName: 'CCR2004-16G-2S+',
      cpuLoadPercent: 31,
      memoryUsedPercent: 14,
      temperatureC: 58,
      voltageV: null,
      activePppoeCount: 350,
      activeHotspotCount: 28,
      hotspotHostCount: 41,
      dhcpLeaseCount: 95,
      bgpPeersEstablished: 0,
      bgpPeersTotal: 0,
      interfaces: [{ name: 'ether1-UP LINK', running: true, disabled: false, rxMbps: 473.1, txMbps: 26.8 }],
      ping: {
        target: ccr.host,
        label: ccr.name,
        minMs: 0.7,
        avgMs: 0.9,
        maxMs: 1.2,
        packetLossPercent: 0,
        status: 'ok' as const,
        updatedAt: new Date().toISOString(),
      },
      status: 'healthy' as const,
    };

    const reply = buildDeterministicLiveReply(ccr, tel, [], [], 'cek trafik uplink');
    assert.ok(reply.includes('ether1-UP LINK'));
    assert.ok(reply.includes('473.1'));

    // Ensure "login" in Hotspot question NEVER falsely triggers the RADIUS/log branch!
    const hsLogs = [
      {
        id: 'hs1',
        routerId: ccr.id,
        sourceIp: ccr.host,
        timestamp: new Date().toISOString(),
        topics: ['hotspot', 'info', 'debug'],
        severity: 'error' as const,
        message: 'voucher99 (10.5.50.14): login failed: invalid username or password',
      },
    ];
    const hsReply = buildDeterministicLiveReply(
      ccr,
      tel,
      [],
      hsLogs,
      'ada berapa user hotspot yang tidak bisa login?',
    );
    assert.ok(hsReply.includes('User Hotspot Aktif: 28'));
    assert.ok(hsReply.includes('Gagal Login Hotspot di Log: 1'));
    assert.ok(hsReply.includes('voucher99'));
    assert.ok(!hsReply.includes('Status RADIUS'));

    // Ensure Ping question returns both router ping and external DNS ping
    const pingReply = buildDeterministicLiveReply(
      ccr,
      tel,
      [],
      [],
      'cek ping sekarang apakah membengkak?',
      [
        {
          target: '1.1.1.1',
          label: 'Cloudflare DNS',
          minMs: 12.1,
          avgMs: 14.5,
          maxMs: 18.2,
          packetLossPercent: 0,
          status: 'ok',
          updatedAt: new Date().toISOString(),
        },
      ],
    );
    assert.ok(pingReply.includes('0.9 ms'));
    assert.ok(pingReply.includes('1.1.1.1'));
    assert.ok(pingReply.includes('14.5 ms'));

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('parses Linux/Windows ping outputs, detects Hotspot failed logins, and persists Fonnte settings', async () => {
    const thresholds = { warnMs: 50, critMs: 100, lossCritPct: 20 };

    const linuxOk = `3 packets transmitted, 3 received, 0% packet loss, time 502ms\nrtt min/avg/max/mdev = 11.201/12.460/13.800/0.912 ms`;
    const p1 = parsePingOutput(linuxOk, '1.1.1.1', 'Cloudflare DNS', thresholds);
    assert.equal(p1.status, 'ok');
    assert.equal(p1.avgMs, 12.5);
    assert.equal(p1.packetLossPercent, 0);

    const linuxSpike = `3 packets transmitted, 3 received, 0% packet loss, time 502ms\nrtt min/avg/max/mdev = 95.0/132.4/180.2/12.1 ms`;
    const p2 = parsePingOutput(linuxSpike, '8.8.8.8', 'Google DNS', thresholds);
    assert.equal(p2.status, 'critical');
    assert.equal(p2.avgMs, 132.4);

    const winHigh = `Packets: Sent = 3, Received = 3, Lost = 0 (0% loss),\nMinimum = 55ms, Maximum = 78ms, Average = 64ms`;
    const p3 = parsePingOutput(winHigh, '192.168.88.1', 'Router', thresholds);
    assert.equal(p3.status, 'high');
    assert.equal(p3.avgMs, 64);

    const rto = `3 packets transmitted, 0 received, 100% packet loss, time 2050ms`;
    const p4 = parsePingOutput(rto, '192.168.88.99', 'DownRouter', thresholds);
    assert.equal(p4.status, 'down');
    assert.equal(p4.packetLossPercent, 100);

    // Hotspot failed login parser
    const hsFail = parseHotspotFailedLogin({
      topics: ['hotspot', 'info'],
      message: '[11:20:01] tamu_07 (10.5.50.22): login failed: invalid username or password',
    });
    assert.equal(hsFail, 'tamu_07');
    assert.equal(
      parseHotspotFailedLogin({
        topics: ['system', 'error'],
        message: 'login failure for user admin from 185.220.101.9 via ssh',
      }),
      null,
    );

    // Fonnte settings store
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'noc-fonnte-test-'));
    const notifier = new FonnteWhatsappNotifier(tmpDir, '', '081200000000', 45, 95);
    await notifier.init();
    assert.equal(notifier.getSettings().pingWarnMs, 45);
    await notifier.updateSettings({ pingWarnMs: 60, waTarget: '081399998888' });

    const reloaded = new FonnteWhatsappNotifier(tmpDir, '', '');
    await reloaded.init();
    assert.equal(reloaded.getSettings().pingWarnMs, 60);
    assert.equal(reloaded.getSettings().waTarget, '081399998888');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('powers centralized SPV NOC across all routers and formats WA fleet summary', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'noc-spv-test-'));
    const store = new ApprovalGateStore(path.join(tmpDir, 'approvals.json'), 30);
    await store.init();
    const bridge = new AntigravityBridgeStore(tmpDir);
    await bridge.init();

    const orchestrator = new NocOrchestrator({
      routers: DEFAULT_ROUTERS,
      approvalStore: store,
      nocServerIp: '192.168.88.10',
      telegramToken: '',
      telegramChatId: '',
      onBroadcast: () => {},
      aiBridge: bridge,
    });
    await orchestrator.pollAllRouters();
    const snap = orchestrator.buildSnapshot();
    assert.equal(snap.spvNoc.id, 'spv-noc');
    assert.equal(snap.spvNoc.name, 'SPV NOC');
    assert.equal(snap.spvNoc.totalRouters, 9);

    const spvHsReply = buildDeterministicSpvReply(snap.agents, [], [], 'cek total user hotspot semua router');
    assert.ok(spvHsReply.includes('SPV NOC'));
    assert.ok(spvHsReply.includes('Hotspot Aktif'));

    const waSummary = buildSpvWhatsappSummary(snap.agents, [], []);
    assert.ok(waSummary.includes('LAPORAN RINGKAS SPV NOC'));

    // Plain-text sanitizer must remove ALL asterisks and uppercase bold/headings cleanly
    const messyMd = `### Laporan Jaringan\n* **CCR-Pusat**: *CPU 31%* dan \`140\` user\n* **Status**: Aman*`;
    const clean = sanitizePlainAiText(messyMd);
    assert.ok(!clean.includes('*'));
    assert.ok(!clean.includes('`'));
    assert.ok(clean.includes('LAPORAN JARINGAN'));
    assert.ok(clean.includes('• CCR-PUSAT: CPU 31% dan 140 user'));
    assert.ok(clean.includes('• STATUS: Aman'));

    // Anti-spam filter verification: daily report only 1x/day & critical ping needs 3x consecutive checks!
    const notifier = new FonnteWhatsappNotifier(tmpDir, 'dummy-token', '081200000000');
    await notifier.init();
    const sentMessages: string[] = [];
    // Stub sendRaw so no real HTTP call happens in unit tests
    (notifier as unknown as { sendRaw: (t: string, m: string) => Promise<{ ok: boolean; detail: string }> }).sendRaw =
      async (_t, m) => {
        sentMessages.push(m);
        return { ok: true, detail: 'mocked' };
      };

    const morningBefore = new Date(2026, 10, 24, 7, 30, 0);
    const morningDue = new Date(2026, 10, 24, 8, 5, 0);
    assert.equal(notifier.shouldSendDailyReport(morningBefore), false);
    assert.equal(notifier.shouldSendDailyReport(morningDue), true);
    await notifier.markDailyReportSent(morningDue);
    // Must NEVER send a second daily report on the same day!
    assert.equal(notifier.shouldSendDailyReport(new Date(2026, 10, 24, 21, 0, 0)), false);

    const orchWithWa = new NocOrchestrator({
      routers: DEFAULT_ROUTERS,
      approvalStore: store,
      nocServerIp: '192.168.88.10',
      telegramToken: '',
      telegramChatId: '',
      onBroadcast: () => {},
      fonnteNotifier: notifier,
    });
    const th = { warnMs: 80, critMs: 150, lossCritPct: 40 };
    const highPing = {
      target: '1.1.1.1',
      label: 'Cloudflare DNS',
      minMs: 70,
      avgMs: 92,
      maxMs: 110,
      packetLossPercent: 0,
      status: 'high' as const,
      updatedAt: new Date().toISOString(),
    };
    const critPing = {
      target: '1.1.1.1',
      label: 'Cloudflare DNS',
      minMs: 160,
      avgMs: 210,
      maxMs: 260,
      packetLossPercent: 40,
      status: 'critical' as const,
      updatedAt: new Date().toISOString(),
    };

    // Warning ('high') ping must NEVER send WA
    await orchWithWa.evaluatePingWhatsappAlert('ping:ext:1.1.1.1', 'spv-noc', 'Internet', 'SPV', highPing, th);
    await orchWithWa.evaluatePingWhatsappAlert('ping:ext:1.1.1.1', 'spv-noc', 'Internet', 'SPV', highPing, th);
    await orchWithWa.evaluatePingWhatsappAlert('ping:ext:1.1.1.1', 'spv-noc', 'Internet', 'SPV', highPing, th);
    assert.equal(sentMessages.length, 0);

    // Critical ping 1x & 2x (transient glitch) must NOT send WA yet; 3rd consecutive check sends 1 WA!
    assert.equal(
      await orchWithWa.evaluatePingWhatsappAlert('ping:ext:1.1.1.1', 'spv-noc', 'Internet', 'SPV', critPing, th),
      false,
    );
    assert.equal(
      await orchWithWa.evaluatePingWhatsappAlert('ping:ext:1.1.1.1', 'spv-noc', 'Internet', 'SPV', critPing, th),
      false,
    );
    assert.equal(sentMessages.length, 0);
    assert.equal(
      await orchWithWa.evaluatePingWhatsappAlert('ping:ext:1.1.1.1', 'spv-noc', 'Internet', 'SPV', critPing, th),
      true,
    );
    assert.equal(sentMessages.length, 1);
    assert.ok(!sentMessages[0]!.includes('*'));

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('parses RouterOS v6/v7 /ping rows and detects Link Down & vlan2000-CMK traffic drop accurately', () => {
    // RouterOS v6 & v7 RTT parsing
    assert.equal(parseRouterOsRttMs('41ms'), 41);
    assert.equal(parseRouterOsRttMs('41ms359us'), 41.4);
    assert.equal(parseRouterOsRttMs('860us'), 0.9);
    assert.equal(parseRouterOsRttMs('1s20ms'), 1020);

    const parsedPing = parseRouterOsPingRows(
      [
        { seq: '0', host: '1.1.1.1', time: '41ms', sent: '1', received: '1', 'packet-loss': '0', 'min-rtt': '41ms', 'avg-rtt': '41ms', 'max-rtt': '41ms' },
        { seq: '1', host: '1.1.1.1', time: '42ms500us', sent: '2', received: '2', 'packet-loss': '0', 'min-rtt': '41ms', 'avg-rtt': '41ms750us', 'max-rtt': '42ms500us' },
      ],
      '1.1.1.1',
      'vlan2000-CMK → 1.1.1.1',
      { warnMs: 80, critMs: 140, lossCritPct: 40 },
    );
    assert.equal(parsedPing.status, 'ok');
    assert.equal(parsedPing.avgMs, 41.8);
    assert.equal(parsedPing.packetLossPercent, 0);

    // Role profile defaults for CORE MONGKONAI and Bima CRS-BB01
    const coreM = DEFAULT_ROUTERS.find((r) => r.id === 'core-mongkonai')!;
    const coreProfile = resolveRouterDutyProfile(coreM);
    assert.equal(coreProfile.dutyRole, 'core_vlan_watchdog');
    assert.ok(coreProfile.watchedInterfaces.includes('vlan2000-CMK'));
    assert.equal(coreProfile.interfacePing?.interfaceName, 'vlan2000-CMK');
    assert.equal(coreProfile.interfacePing?.target, '1.1.1.1');

    const bima = DEFAULT_ROUTERS.find((r) => r.id === 'crs-backbone-01')!;
    const bimaProfile = resolveRouterDutyProfile(bima);
    assert.equal(bimaProfile.dutyRole, 'backbone_master');

    // Smart traffic drop watchdog on vlan2000-CMK:
    // - Normal dip (200 Mbps -> 25 Mbps) or nighttime quiet hours (01:30) must NOT trigger false alarm!
    // - True frozen-link collapse (200 Mbps -> 0.2 Mbps during active daytime 14:00) fires once after 6 checks!
    const daytime = new Date(2026, 10, 25, 14, 0, 0);
    const nightQuiet = new Date(2026, 10, 25, 1, 30, 0);
    const watchdog = new LinkWatchdogEngine();
    for (let i = 0; i < 8; i++) {
      const { events } = watchdog.evaluateRouterInterfaces(
        coreM,
        [{ name: 'vlan2000-CMK', running: true, disabled: false, rxMbps: 120, txMbps: 80 }],
        3,
        undefined,
        daytime,
      );
      assert.equal(events.length, 0);
    }
    // Nighttime quiet drop to 0.3 Mbps at 01:30 -> 0 alerts!
    for (let i = 0; i < 7; i++) {
      const { events } = watchdog.evaluateRouterInterfaces(
        coreM,
        [{ name: 'vlan2000-CMK', running: true, disabled: false, rxMbps: 0.2, txMbps: 0.1 }],
        3,
        undefined,
        nightQuiet,
      );
      assert.equal(events.length, 0);
    }
    // Daytime frozen collapse to 0.2 Mbps at 14:00 -> fires once on 6th check!
    let firedDrop = 0;
    for (let i = 0; i < 6; i++) {
      const { events } = watchdog.evaluateRouterInterfaces(
        coreM,
        [{ name: 'vlan2000-CMK', running: true, disabled: false, rxMbps: 0.1, txMbps: 0.1 }],
        3,
        undefined,
        daytime,
      );
      firedDrop += events.filter((e) => e.kind === 'drop').length;
    }
    assert.equal(firedDrop, 1);

    // Link down detection on Bima CRS-BB01 (fires on 3rd consecutive down check!)
    watchdog.evaluateRouterInterfaces(bima, [
      { name: 'sfp5-TO LOLAN-BANGO', running: true, disabled: false, rxMbps: 40, txMbps: 30 },
    ]);
    let firedDown = 0;
    for (let i = 0; i < 4; i++) {
      const { events } = watchdog.evaluateRouterInterfaces(bima, [
        { name: 'sfp5-TO LOLAN-BANGO', running: false, disabled: false, rxMbps: 0, txMbps: 0 },
      ]);
      firedDown += events.filter((e) => e.kind === 'down').length;
    }
    assert.equal(firedDown, 1);
  });

  it('persists manual Fiber Topology links, detects PPPoE Mass-Disconnect, and learns from chat AI Memory', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'noc-topo-mem-test-'));

    // 1. TopologyStore manual fiber cable + live status calculation
    const topo = new TopologyStore(tmpDir);
    await topo.init();
    const added = await topo.addLink({
      fromRouterId: 'core-mongkonai',
      fromInterface: 'vlan2000-CMK',
      toRouterId: 'ccr-momonet-pusat',
      toInterface: 'ether1-UP LINK',
      label: 'Suplai Utama CCR',
      fiberType: 'vlan',
    });
    await topo.savePositions([{ routerId: 'core-mongkonai', x: 140, y: 240 }]);

    const reloadedTopo = new TopologyStore(tmpDir);
    await reloadedTopo.init();
    assert.equal(reloadedTopo.getLinks().length, 1);
    assert.equal(reloadedTopo.getPositions()[0]?.x, 140);

    const telMap = new Map([
      [
        'core-mongkonai',
        {
          routerId: 'core-mongkonai',
          timestamp: new Date().toISOString(),
          reachable: true,
          uptime: '5d',
          version: '6.49',
          boardName: 'CCR',
          cpuLoadPercent: 20,
          memoryUsedPercent: 20,
          temperatureC: 45,
          voltageV: null,
          activePppoeCount: 0,
          activeHotspotCount: 0,
          hotspotHostCount: 0,
          dhcpLeaseCount: 0,
          bgpPeersEstablished: 0,
          bgpPeersTotal: 0,
          interfaces: [{ name: 'vlan2000-CMK', running: true, disabled: false, rxMbps: 420, txMbps: 40 }],
          status: 'healthy' as const,
        },
      ],
    ]);
    const liveLinks = reloadedTopo.buildLiveLinks(DEFAULT_ROUTERS, telMap);
    assert.equal(liveLinks[0]?.status, 'ok');
    assert.equal(liveLinks[0]?.liveMbps, 460);

    await reloadedTopo.deleteLink(added.id);
    assert.equal(reloadedTopo.getLinks().length, 0);

    // 2. PppoeMassDisconnectWatchdog (detects OLT/FO cut on 2nd consecutive poll & recovers cleanly)
    const ccr = DEFAULT_ROUTERS.find((r) => r.id === 'ccr-momonet-pusat')!;
    const pppWatch = new PppoeMassDisconnectWatchdog();
    const now = Date.now();
    assert.equal(pppWatch.evaluate(ccr, 350, [], [], 15, now), null);
    assert.equal(pppWatch.evaluate(ccr, 348, [], [], 15, now + 3000), null);
    // Small normal drop (3 users) -> ignored
    assert.equal(pppWatch.evaluate(ccr, 345, [], [], 15, now + 6000), null);
    // Sudden OLT cut: 55 users drop -> 1st poll waits confirm, 2nd poll fires mass_disconnect!
    const downIfs = [{ name: 'ether9-OLT-GLOBAL-01', running: false, disabled: false, rxMbps: 0, txMbps: 0 }];
    assert.equal(pppWatch.evaluate(ccr, 290, downIfs, [], 15, now + 9000), null);
    const massEv = pppWatch.evaluate(ccr, 290, downIfs, [], 15, now + 12000);
    assert.equal(massEv?.kind, 'mass_disconnect');
    assert.equal(massEv?.droppedCount, 60);
    assert.ok(massEv?.suspectedOltInterfaces.includes('ether9-OLT-GLOBAL-01'));
    // Recovery after 3 stable polls >= 85%
    assert.equal(pppWatch.evaluate(ccr, 340, [], [], 15, now + 15000), null);
    assert.equal(pppWatch.evaluate(ccr, 342, [], [], 15, now + 18000), null);
    const recEv = pppWatch.evaluate(ccr, 345, [], [], 15, now + 21000);
    assert.equal(recEv?.kind, 'recovered');

    // 3. AiMemoryStore long-term chat & teaching fact learning
    assert.equal(
      detectTeachingFact('Ingat ya: OLT Global 01 melayani area Mongkonai Timur'),
      'OLT Global 01 melayani area Mongkonai Timur',
    );
    const mem = new AiMemoryStore(tmpDir);
    await mem.init();
    const { learnedFact } = await mem.recordConversation(
      'Telegram (BrayenKenzi)',
      'Ingat ya: OLT Global 01 melayani area Mongkonai Timur',
      'Siap Boss, sudah saya simpan!',
      'SPV NOC',
    );
    assert.ok(learnedFact);

    const memReloaded = new AiMemoryStore(tmpDir);
    await memReloaded.init();
    assert.equal(memReloaded.getSummary().totalConversations, 1);
    const ctx = memReloaded.retrieveRelevantContext('area mana yang dilayani OLT Global 01?');
    assert.ok(ctx.relevantFacts.some((f) => f.text.includes('Mongkonai Timur')));

    const localSpvAnswer = buildDeterministicSpvReply([], [], [], 'cek memori OLT Global 01', undefined, [], ctx);
    assert.ok(localSpvAnswer.includes('Mongkonai Timur'));

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('handles Read-Only manual acknowledgment cleanly and supports central SPV write account', async () => {
    const router = { ...DEFAULT_ROUTERS[0]!, simulated: false, execSecretEnv: 'TEST_NONEXISTENT_ROUTER_SECRET' };
    const prevSpvUser = process.env.SPV_EXEC_USERNAME;
    const prevSpvSecret = process.env.SPV_EXEC_SECRET;
    delete process.env.SPV_EXEC_USERNAME;
    delete process.env.SPV_EXEC_SECRET;
    delete process.env.TEST_NONEXISTENT_ROUTER_SECRET;

    try {
      assert.equal(hasWriteCredentialsForRouter(router), false);
      assert.equal(resolveWriteCredentials(router), null);

      const out = await executeApprovedProposal(router, {
        actionType: 'ENABLE_INTERFACE',
        parameters: { interface: 'sfp2-LOLAN' },
        previewCommand: '/interface enable "sfp2-LOLAN"',
        rollbackCommand: '/interface disable "sfp2-LOLAN"',
        riskLevel: 'MEDIUM',
      });
      assert.ok(out.includes('MODE READ-ONLY'));
      assert.ok(out.includes('/interface enable "sfp2-LOLAN"'));

      process.env.SPV_EXEC_USERNAME = 'spv_master';
      process.env.SPV_EXEC_SECRET = 'temporary-test-only';
      assert.equal(hasWriteCredentialsForRouter(router), true);
      const creds = resolveWriteCredentials(router);
      assert.equal(creds?.source, 'spv');
      assert.equal(creds?.username, 'spv_master');
    } finally {
      if (prevSpvUser === undefined) delete process.env.SPV_EXEC_USERNAME;
      else process.env.SPV_EXEC_USERNAME = prevSpvUser;
      if (prevSpvSecret === undefined) delete process.env.SPV_EXEC_SECRET;
      else process.env.SPV_EXEC_SECRET = prevSpvSecret;
    }
  });

  it('monitors SFP optical dBm, matches PPPoE/Hotspot customers, and exports clean .rsc with diff', () => {
    const crs = DEFAULT_ROUTERS[0]!;

    // 1. SFP Optical dBm Monitor & Watchdog
    const idleSlot = parseSfpMonitorRow('sfp-sfpplus4', { status: 'no-link', 'sfp-module-present': 'false' });
    assert.equal(idleSlot.health, 'empty');

    const warnPort = parseSfpMonitorRow('sfp5-TO LOLAN-BANGO', {
      status: 'link-ok',
      'sfp-module-present': 'true',
      'sfp-rx-power': '-21.023',
      'sfp-tx-power': '-3',
      'sfp-temperature': '46',
      'sfp-vendor-name': 'Tarmoc',
    });
    assert.equal(warnPort.health, 'warning');
    assert.equal(warnPort.rxPowerDbm, -21.02);

    const critPort = parseSfpMonitorRow('sfp5-TO LOLAN-BANGO', {
      status: 'link-ok',
      'sfp-module-present': 'true',
      'sfp-rx-power': '-25.45',
      'sfp-tx-power': '-3.1',
      'sfp-temperature': '49',
    });
    assert.equal(critPort.health, 'critical');

    const sfpWatch = new SfpOpticalWatchdog();
    assert.equal(sfpWatch.evaluate(crs, [warnPort], -24, 3).events.length, 0);
    assert.equal(sfpWatch.evaluate(crs, [critPort], -24, 3).events.length, 0);
    assert.equal(sfpWatch.evaluate(crs, [critPort], -24, 3).events.length, 0);
    const thirdEval = sfpWatch.evaluate(crs, [critPort], -24, 3);
    assert.equal(thirdEval.events.length, 1);
    assert.equal(thirdEval.events[0]?.kind, 'high_attenuation');

    // 2. Customer Lookup Parser & Plain-Text Formatter
    assert.equal(extractCustomerLookupQuery('/cek budi_mongkonai'), 'budi_mongkonai');
    assert.equal(extractCustomerLookupQuery('SPV NOC, cek pelanggan andika01'), 'andika01');
    assert.equal(extractCustomerLookupQuery('cek semua router'), null);

    const matches = matchSessionRows(
      crs,
      [{ name: 'budi_mongkonai', address: '10.50.1.22', 'caller-id': 'AA:BB:CC:11:22:33', uptime: '2d4h', radius: 'true' }],
      [{ user: 'voucher_budi', address: '10.60.0.15', 'mac-address': 'DD:EE:FF:44:55:66', uptime: '1h12m', 'bytes-in': '10485760', 'bytes-out': '52428800' }],
      'budi',
    );
    assert.equal(matches.length, 2);
    const plainLookup = formatCustomerLookupPlainText({
      query: 'budi',
      searchedRouters: 7,
      matches,
      relatedLogs: [],
      checkedAt: new Date().toISOString(),
    });
    assert.ok(!plainLookup.includes('*'));
    assert.ok(plainLookup.includes('DITEMUKAN 2 SESI AKTIF'));

    // 3. Clean .rsc Export (strips volatile counters + redacts secrets) & Config Diff
    assert.equal(toSafeRscFileName('CCR-Pusat MomoNet / Core'), 'CCR-Pusat-MomoNet-Core.rsc');
    const rsc1 = buildRscFromSectionRows(crs, { 'board-name': 'CRS317', version: '7.15' }, [
      {
        cliPath: '/radius',
        rows: [{ '.id': '*1', address: '10.10.10.5', secret: 'supersecret123', service: 'ppp,hotspot' }],
      },
      {
        cliPath: '/ip firewall filter',
        rows: [{ '.id': '*2', action: 'accept', chain: 'input', bytes: '9999999', packets: '8888' }],
      },
    ]);
    assert.ok(!rsc1.includes('supersecret123'));
    assert.ok(rsc1.includes('<REDACTED>'));
    assert.ok(!rsc1.includes('9999999'));
    assert.equal(computeRscDiff(rsc1, rsc1).addedLines, 0);

    const rsc2 = `${rsc1}\n/ip address\nadd address=10.99.0.1/24 interface=vlan2000-CMK\n`;
    const diff = computeRscDiff(rsc1, rsc2);
    assert.equal(diff.addedLines, 2);
    assert.equal(diff.removedLines, 0);
  });

  it('decodes TCP-fragmented CRS106 SFP sentences, learns 24h traffic patterns, and composes neat SPV AI reports', async () => {
    // 1. TCP-fragmented RouterOS binary sentence must NEVER drop leading !re words
    const fullPacket = Buffer.concat([
      encodeSentence([
        '!re',
        '=name=sfp2-LOLAN',
        '=status=link-ok',
        '=sfp-module-present=true',
        '=sfp-rx-power=-21.87',
        '=sfp-tx-power=-3.079',
        '=sfp-vendor-name=OEM',
      ]),
      encodeSentence(['!done']),
    ]);
    let buf: Buffer = Buffer.alloc(0);
    const collected: string[][] = [];
    // Feed in tiny 11-byte TCP fragments!
    for (let pos = 0; pos < fullPacket.length; pos += 11) {
      buf = Buffer.concat([buf, fullPacket.subarray(pos, Math.min(fullPacket.length, pos + 11))]);
      const { sentences, remaining } = decodeWordsFromBuffer(buf);
      buf = remaining;
      collected.push(...sentences);
    }
    assert.equal(collected.length, 2);
    assert.equal(collected[0]?.[0], '!re');
    const attrs = parseSentenceAttributes(collected[0]!);
    assert.equal(attrs['sfp-rx-power'], '-21.87');

    // 2. TrafficPatternLearner & Neat SPV AI Report Composer with custom router & agent names
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'noc-pattern-test-'));
    const learner = new TrafficPatternLearner(tmpDir);
    await learner.init();
    assert.equal(learner.isNormalBandwidthPattern('core-mongkonai', 'vlan2000-CMK', 0.4, new Date(2026, 10, 25, 2, 0, 0)), true);
    assert.equal(learner.isNormalBandwidthPattern('core-mongkonai', 'vlan2000-CMK', 18, new Date(2026, 10, 25, 19, 0, 0)), true);

    const incReport = await composeSpvVerifiedIncidentReport({
      incidents: [
        {
          key: 'linkdown:crs-backbone-03:sfp2-LOLAN',
          category: 'link',
          routerId: 'crs-backbone-03',
          routerName: 'CRS-Bangomolunow',
          agentName: 'Bayu (CRS Bango)',
          headline: 'Link fisik sfp2-LOLAN pada CRS-Bangomolunow PUTUS / DOWN',
          verificationNote: 'Tes ulang API memastikan port sfp2-LOLAN masih DOWN',
          detectedAt: new Date().toISOString(),
        },
      ],
      agents: [],
      topologyLinks: [],
    });
    assert.ok(incReport.includes('CRS-Bangomolunow'));
    assert.ok(incReport.includes('Bayu (CRS Bango)'));
    assert.ok(incReport.includes('KESIMPULAN ANALISA SPV AI'));
    assert.ok(!incReport.includes('*'));

    const execReport = await composeSpvExecutiveReport({
      agents: [],
      externalPings: [{ target: '1.1.1.1', label: 'Cloudflare', minMs: 35, avgMs: 38, maxMs: 42, packetLossPercent: 0, status: 'ok', updatedAt: new Date().toISOString() }],
      reports: [],
      isDailyReport: true,
      useAiConclusion: false,
    });
    assert.ok(execReport.includes('LAPORAN HARIAN SPV NOC'));
    assert.ok(execReport.includes('KESIMPULAN ANALISA SPV AI'));
    assert.ok(!execReport.includes('*'));

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('never creates false ENABLE_INTERFACE tickets for active/non-disabled links or LAN login typos', () => {
    const crs = DEFAULT_ROUTERS.find((r) => r.id === 'crs-backbone-02')!;
    const linkDownLog = {
      id: 'log-1',
      routerId: crs.id,
      sourceIp: crs.host,
      timestamp: new Date().toISOString(),
      topics: ['interface', 'info'],
      severity: 'info' as const,
      message: 'sfp1-MONGKONAI link down',
    };

    // Case 1: Port is UP & running right now -> must NOT create ticket!
    const upTel = {
      routerId: crs.id,
      timestamp: new Date().toISOString(),
      reachable: true,
      uptime: '5d',
      version: '6.48.6',
      boardName: 'CRS106',
      cpuLoadPercent: 10,
      memoryUsedPercent: 30,
      temperatureC: 42,
      voltageV: 24,
      activePppoeCount: 0,
      activeHotspotCount: 0,
      hotspotHostCount: 0,
      dhcpLeaseCount: 0,
      bgpPeersEstablished: 0,
      bgpPeersTotal: 0,
      interfaces: [{ name: 'sfp1-MONGKONAI', running: true, disabled: false, rxMbps: 50, txMbps: 20 }],
      status: 'healthy' as const,
    };
    assert.equal(deterministicDiagnosis(crs, upTel, [linkDownLog]).requiresAction, false);

    // Case 2: Port is physically down (`running: false`) but NOT disabled (`disabled: false`) -> must NOT propose `/interface enable`!
    const physDownTel = {
      ...upTel,
      interfaces: [{ name: 'sfp1-MONGKONAI', running: false, disabled: false, rxMbps: 0, txMbps: 0 }],
    };
    assert.equal(deterministicDiagnosis(crs, physDownTel, [linkDownLog]).requiresAction, false);

    // Case 3: Port IS actually disabled (`disabled: true`) -> validly proposes ENABLE_INTERFACE
    const disabledTel = {
      ...upTel,
      interfaces: [{ name: 'sfp1-MONGKONAI', running: false, disabled: true, rxMbps: 0, txMbps: 0 }],
    };
    const resDisabled = deterministicDiagnosis(crs, disabledTel, [linkDownLog]);
    assert.equal(resDisabled.requiresAction, true);
    assert.equal(resDisabled.proposal?.actionType, 'ENABLE_INTERFACE');

    // Case 4: Local LAN IP login typo must NOT propose firewall block
    const lanTypoLog = {
      ...linkDownLog,
      id: 'log-2',
      message: 'login failure for user admin from 192.168.88.50 via winbox',
    };
    assert.equal(deterministicDiagnosis(crs, upTel, [lanTypoLog]).requiresAction, false);

    // Case 5: parseRouterApiLogs must filter out 1970 boot & previous-day logs, keeping only live HH:MM:SS logs
    const parsedLogs = parseRouterApiLogs(crs, [
      { '.id': '*1', time: 'feb/01/1970 00:00:39', topics: 'system,error,critical', message: 'router was rebooted without proper shutdown' },
      { '.id': '*2', time: 'nov/24 15:51:58', topics: 'system,info', message: 'system time zone settings changed' },
      { '.id': '*3', time: '23:31:15', topics: 'system,info', message: 'user admin logged in' },
    ]);
    assert.equal(parsedLogs.length, 1);
    assert.ok(parsedLogs[0]?.message.includes('23:31:15'));
  });
});
