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
import { parseMikrotikSyslog, isAnomalySyslog, parseRadiusTimeoutUser } from '../src/syslogReceiver.js';
import { validateAndBuildPlaybook } from '../src/playbooks.js';
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
import { AntigravityBridgeStore, buildDeterministicLiveReply } from '../src/antigravityBridge.js';

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
    const reply = buildDeterministicLiveReply(
      ccr,
      {
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
        bgpPeersEstablished: 0,
        bgpPeersTotal: 0,
        interfaces: [{ name: 'ether1-UP LINK', running: true, disabled: false, rxMbps: 473.1, txMbps: 26.8 }],
        status: 'healthy',
      },
      [],
      [],
      'cek trafik uplink',
    );
    assert.ok(reply.includes('ether1-UP LINK'));
    assert.ok(reply.includes('473.1'));

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
