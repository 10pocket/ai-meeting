import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.PORT = '0';
process.env.DATA_DIR = fs.mkdtempSync('/tmp/ai-meeting-test-');
delete process.env.OPENAI_API_KEY;
const { server, makeChunks, monthly } = await import('./server.js');
import { once } from 'node:events';
if (!server.address()) await once(server, 'listening');
server.unref();
const base = `http://127.0.0.1:${server.address().port}`;
const api = (p, init) => fetch(base + p, init).then(r => r.json());

test('upload → list → range → finish (no key → error)', async () => {
  const { id } = await api('/api/recordings', { method: 'POST' });
  for (const c of ['abc', 'def']) await api(`/api/recordings/${id}/chunk`, { method: 'POST', body: c });
  assert.equal(fs.readFileSync(`${process.env.DATA_DIR}/${id}/upload.webm`, 'utf8'), 'abcdef');
  assert.equal((await api('/api/recordings'))[0].id, id);
  await api(`/api/recordings/${id}/finish`, { method: 'POST' });
  let meta; for (let i = 0; i < 50 && (meta = await api(`/api/recordings/${id}`)).status !== 'error'; i++) await new Promise(r => setTimeout(r, 20));
  assert.match(meta.title, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.match(meta.error, /OPENAI_API_KEY/);
  // Range (upload.webm は配信対象外なので UI の index.html で確認)
  const r = await fetch(base + '/', { headers: { Range: 'bytes=0-4' } });
  assert.equal(r.status, 206); assert.equal((await r.text()).length, 5);
  // 話者名: 保存 → 詳細と入力履歴に出る。不正な鍵は 400
  const post = body => fetch(`${base}/api/recordings/${id}/speakers`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post({ 話者1: ' 山田 ', 話者2: '' })).status, 200);
  assert.equal((await post({ x: 'a' })).status, 400);
  meta = await api(`/api/recordings/${id}`);
  assert.deepEqual([meta.speakers, meta.names, meta.usage], [{ 話者1: '山田' }, ['山田'], []]);
  assert.ok(meta.bytes > 0);
  const admin = await api('/api/admin');
  assert.deepEqual(admin.months, []); assert.ok(admin.storage.recordings > 0);
  await api(`/api/recordings/${id}`, { method: 'DELETE' });
  assert.equal((await api('/api/recordings')).length, 0);
  server.close();
});

test('makeChunks: 近い同話者をつなぐ / 短い区間は吸収 / 長い区間は割る / 重なりを切る', () => {
  const c = makeChunks([
    { start: 0, end: 4, speaker: 0 }, { start: 4.5, end: 8, speaker: 0 }, // 間 0.5s → つなぐ
    { start: 8, end: 8.4, speaker: 1 },                                    // 0.4s → 直前に吸収
    { start: 10, end: 15, speaker: 1 }, { start: 14, end: 20, speaker: 0 }, // 重なりは後ろ側を切る
    { start: 30, end: 930, speaker: 1 },                                   // 900s → 3 つに割る
  ]);
  assert.deepEqual(c.slice(0, 3).map(x => [x.start, x.end, x.speaker]), [[0, 8.4, 0], [10, 15, 1], [15, 20, 0]]);
  assert.equal(c.length, 6);
  assert.ok(c.slice(3).every(x => x.speaker === 1 && Math.abs(x.end - x.start - 300) < 1e-6));
});

test('monthly: 月 (JST) と API ごとに合計し、単価未設定は 0 で数える', () => {
  assert.deepEqual(monthly([
    { at: '2026-10-31T16:00:00Z', api: 'transcribe', usd: 0.1 }, // JST では 11 月
    { at: '2026-11-02T00:00:00Z', api: 'minutes', usd: null },
    { at: '2026-10-01T00:00:00Z', api: 'minutes', usd: 0.2 },
  ]), [{ month: '2026-10', transcribe: 0, minutes: 0.2 }, { month: '2026-11', transcribe: 0.1, minutes: 0 }]);
});
