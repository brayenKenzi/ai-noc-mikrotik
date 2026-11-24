// Tes logika Kantor AI NOC: node scripts/test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const O = (await runnerImport(path.join(root, 'src/office.ts'), { root, configFile: false, cacheDir: path.join(os.tmpdir(), 'kantor-vite'), logLevel: 'error' })).module;

let n = 0;
const t = (_name, fn) => {
  fn();
  n++;
};

t('jadwal NOC 24/7 aktif memantau', () => {
  assert.equal(O.agentDoing('crs-backbone-01', 1, '08:15').activity, 'kerja');
  assert.equal(O.agentDoing('ccr-momonet-pusat', 1, '16:15').activity, 'laporan');
  assert.equal(O.agentDoing('rb750-qairen', 7, '22:00').activity, 'kerja');
});

t('timelapse tiga babak NOC, berulang', () => {
  assert.equal(O.LAPSE_SECONDS, 30);
  assert.equal(O.lapseAt(0).time, '07:28');
  assert.equal(O.lapseAt(16).act, 1);
  assert.equal(O.lapseAt(30).time, '07:28');
});

t('agen santai pergi dan kembali', () => {
  const seen = new Set();
  for (let x = 0; x < 48; x += 0.5) seen.add(O.idleAt('crs-backbone-01', x).spot);
  assert.ok(seen.has('meja') && seen.size >= 3);
});

t('9 meja router MikroTik dan Mission Board', () => {
  const desks = O.officeDesks(1, '10:00');
  assert.equal(desks.length, 9);
  assert.ok(desks.every((d) => d.bubble));
  assert.ok(O.missionBoard(desks).metrics.length >= 1);
});

t('parameter URL', () => {
  assert.deepEqual(O.params(new URLSearchParams('timelapse=1&rekam=1&jam=08.10')), {
    lapse: true,
    rec: true,
    time: '08:10',
    alwaysWork: true,
  });
});

const G = (await runnerImport(path.join(root, 'src/gaya/daftar.ts'), { root, configFile: false, cacheDir: path.join(os.tmpdir(), 'kantor-vite'), logLevel: 'error' })).module;
t('17 gaya + datacenter, urutan pilihan gaya', () => {
  assert.equal(G.DAFTAR_GAYA.length, 18);
  assert.equal(new Set(G.DAFTAR_GAYA.map((g) => g.id)).size, 18);
  assert.equal(G.DAFTAR_GAYA[0].id, 'datacenter');
});

console.log(`${n} tes frontend NOC lulus`);
