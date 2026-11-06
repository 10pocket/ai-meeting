import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.PORT = '0';
process.env.DATA_DIR = fs.mkdtempSync('/tmp/ai-meeting-test-');
delete process.env.OPENAI_API_KEY;
const { server } = await import('./server.js');
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
  await api(`/api/recordings/${id}`, { method: 'DELETE' });
  assert.equal((await api('/api/recordings')).length, 0);
  server.close();
});
