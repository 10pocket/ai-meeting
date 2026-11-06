// ai-meeting: 録画の受け口 + 文字起こし/議事録パイプライン + 閲覧 UI。依存なし (node 24 + ffmpeg)。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PORT = +(process.env.PORT || 8790);
const DATA = path.resolve(process.env.DATA_DIR || 'data');
const KEY = process.env.OPENAI_API_KEY;
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'gpt-transcribe';
const MINUTES_MODEL = process.env.MINUTES_MODEL || 'gpt-5.6-terra';
const SPEAKERS = process.env.NUM_SPEAKERS || '-1'; // 人数が分かっているなら指定すると精度が上がる。-1 は自動
const MAX_CHUNK_SEC = 300; // 1回の文字起こしに渡す最大長 (25MB 上限に余裕を持たせる)
const PAD_SEC = 0.15; // 話者境界は数百ms ずれるので、前後に少し余白を付けて切る
const PUBLIC = path.join(import.meta.dirname, 'public');
const MINUTES_PROMPT = `あなたは会議の議事録作成者です。渡された文字起こし (発言ごとに [hh:mm:ss] 話者N: の形式) から、日本語で Markdown の議事録を作成します。
最初の行は「# 」で始まる 20 文字以内のタイトル (会議の内容が一目で分かるもの)。続けて次の順で、該当なしの節は「なし」と書く:
## 概要 (3行以内)
## 決定事項 (箇条書き。決まったことだけ。議論中・提案止まりは含めない)
## アクションアイテム (箇条書き。「担当: 〜 / 期限: 〜」が分かる範囲で付ける)
## 議論のポイント (論点ごとに簡潔に。根拠になった発言の時刻を [hh:mm:ss] で添える)
## 未決事項・持ち越し
文字起こしにない情報を補わない。話者は「話者N」のまま書く。会話の中の名乗りや呼びかけから名前が分かる場合に限り名前で書く。話者分離の誤りで同じ人が別の話者になったり、別の人が混ざったりすることがあるので、話者の取り違えが疑われる箇所は断定しない。`;

fs.mkdirSync(DATA, { recursive: true });

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const dir = id => { if (!/^[\w-]+$/.test(id)) throw new HttpError(400, 'bad id'); return path.join(DATA, id); };
const readMeta = async id => JSON.parse(await fsp.readFile(path.join(dir(id), 'meta.json'), 'utf8').catch(() => { throw new HttpError(404, 'not found'); }));
const patchMeta = async (id, p) => { const m = { ...(await readMeta(id)), ...p }; await fsp.writeFile(path.join(dir(id), 'meta.json'), JSON.stringify(m, null, 2)); return m; };
const hms = s => [s / 3600, s / 60 % 60, s % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':');
const readText = fp => fsp.readFile(fp, 'utf8').catch(() => null);
const stamp = iso => new Date(iso).toLocaleString('sv-SE', { timeZone: process.env.TZ || 'Asia/Tokyo' }).slice(0, 16); // 2026-11-03 20:15

// ---- パイプライン ----
async function openai(pathname, body, headers = {}) {
  const r = await fetch('https://api.openai.com/v1' + pathname, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, ...headers }, body });
  if (!r.ok) throw new Error(`OpenAI ${pathname} ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return r.json();
}
async function transcribe(file) {
  const fd = new FormData();
  fd.append('file', new Blob([await fsp.readFile(file)], { type: 'audio/mpeg' }), path.basename(file));
  fd.append('model', TRANSCRIBE_MODEL);
  if (process.env.TRANSCRIBE_PROMPT) fd.append('prompt', process.env.TRANSCRIBE_PROMPT); // 固有名詞のヒント
  return (await openai('/audio/transcriptions', fd)).text;
}
async function summarize(transcript) {
  const body = JSON.stringify({ model: MINUTES_MODEL, messages: [
    { role: 'system', content: MINUTES_PROMPT },
    { role: 'user', content: transcript },
  ] });
  return (await openai('/chat/completions', body, { 'Content-Type': 'application/json' })).choices[0].message.content;
}
// 話者区間 → 文字起こし単位。同じ話者の近い区間はつなぎ、短すぎる区間は直前に吸収し、長すぎる区間は割る。
export function makeChunks(turns) {
  const out = [];
  for (const t of [...turns].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && t.end <= last.end) continue; // 重なり発言で完全に内側に入るものは捨てる
    const c = { ...t, start: last ? Math.max(t.start, last.end) : t.start };
    if (last && c.speaker === last.speaker && c.start - last.end < 1.5) last.end = c.end;
    else if (last && c.end - c.start < 1) last.end = c.end;
    else out.push(c);
  }
  return out.flatMap(c => {
    const n = Math.ceil((c.end - c.start) / MAX_CHUNK_SEC), len = (c.end - c.start) / n;
    return Array.from({ length: n }, (_, i) => ({ ...c, start: c.start + i * len, end: c.start + (i + 1) * len }));
  });
}
async function pool(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}
async function processRecording(id) {
  const d = dir(id);
  try {
    const meta = await patchMeta(id, { status: 'processing', error: null });
    if (!KEY) throw new Error('OPENAI_API_KEY is not set');
    const upload = path.join(d, 'upload.webm'), video = path.join(d, 'recording.webm');
    if (fs.existsSync(upload)) { // MediaRecorder の追記 webm は長さも cue も無く seek できない。copy で書き直す。
      await exec('ffmpeg', ['-y', '-i', upload, '-c', 'copy', video]);
      await fsp.unlink(upload);
    }
    const wav = path.join(d, 'audio.wav'), seg = path.join(d, 'audio');
    await exec('ffmpeg', ['-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', wav]);
    const duration = (fs.statSync(wav).size - 44) / 32000; // 16kHz 16bit モノラル
    let chunks, warning = null;
    try { // 話者ごとの発言単位に切る。失敗しても文字起こしは止めず、話者なしで固定長に切る
      await exec('python3', [path.join(import.meta.dirname, 'diarize.py'), wav, path.join(d, 'diarization.json'), SPEAKERS, '6'], { timeout: 3600e3 });
      chunks = makeChunks(JSON.parse(await fsp.readFile(path.join(d, 'diarization.json'), 'utf8')));
    } catch (e) {
      warning = '話者分離に失敗: ' + String(e.stderr?.slice(-300) || e.message);
      chunks = Array.from({ length: Math.ceil(duration / MAX_CHUNK_SEC) }, (_, i) => ({ start: i * MAX_CHUNK_SEC, end: Math.min((i + 1) * MAX_CHUNK_SEC, duration), speaker: null }));
    }
    await fsp.rm(seg, { recursive: true, force: true }); await fsp.mkdir(seg);
    const texts = await pool(chunks, 6, async (c, i) => {
      const f = path.join(seg, String(i).padStart(4, '0') + '.mp3');
      const from = Math.max(c.start - PAD_SEC, 0);
      await exec('ffmpeg', ['-y', '-ss', String(from), '-t', String(Math.min(c.end + PAD_SEC, duration) - from), '-i', wav, '-b:a', '48k', f]);
      return (await transcribe(f)).trim();
    });
    const names = new Map(); // 話者は登場順に 話者1, 話者2 …
    const transcript = chunks.map((c, i) => {
      if (c.speaker !== null && !names.has(c.speaker)) names.set(c.speaker, `話者${names.size + 1}`);
      return texts[i] && `[${hms(c.start)}] ${c.speaker === null ? '' : names.get(c.speaker) + ': '}${texts[i]}`;
    }).filter(Boolean).join('\n');
    await fsp.writeFile(path.join(d, 'transcript.txt'), transcript);
    const minutes = await summarize(transcript);
    await fsp.writeFile(path.join(d, 'minutes.md'), minutes);
    const t = minutes.match(/^#\s+(.+)$/m)?.[1].trim(); // 1行目の「# タイトル」。再処理しても createdAt から組み直すので重ならない
    await patchMeta(id, { status: 'done', warning, title: t ? `${stamp(meta.createdAt)} ${t}` : stamp(meta.createdAt) });
  } catch (e) {
    await patchMeta(id, { status: 'error', error: String(e.stderr?.slice(-500) || e.message || e) });
  }
}

// ---- HTTP ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
function send(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
async function sendFile(req, res, fp) {
  const st = await fsp.stat(fp).catch(() => null);
  if (!st) throw new HttpError(404, 'not found');
  let start = 0, end = st.size - 1, status = 200;
  const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (r && st.size && (r[1] || r[2])) { // <video> の seek 用
    if (r[1]) { start = +r[1]; if (r[2]) end = Math.min(+r[2], end); } else start = Math.max(st.size - +r[2], 0);
    status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
  }
  res.writeHead(status, { 'Content-Type': TYPES[path.extname(fp)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
  fs.createReadStream(fp, { start, end }).pipe(res);
}
async function route(req, res) {
  const p = new URL(req.url, 'http://x').pathname, m = req.method;
  let g;
  if (p === '/' && m === 'GET') return sendFile(req, res, path.join(PUBLIC, 'index.html'));
  if (p === '/extension.zip' && m === 'GET') { // Chrome 拡張の配布。落として chrome://extensions に読み込む
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="ai-meeting-extension.zip"' });
    return spawn('zip', ['-qr', '-', 'extension'], { cwd: import.meta.dirname }).stdout.pipe(res);
  }
  if (p === '/api/recordings' && m === 'GET') {
    const ids = (await fsp.readdir(DATA)).filter(id => fs.existsSync(path.join(DATA, id, 'meta.json')));
    const list = await Promise.all(ids.map(readMeta));
    return send(res, 200, list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  if (p === '/api/recordings' && m === 'POST') {
    const createdAt = new Date().toISOString();
    const id = createdAt.slice(0, 19).replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6);
    await fsp.mkdir(dir(id));
    await fsp.writeFile(path.join(dir(id), 'meta.json'), JSON.stringify({ id, title: stamp(createdAt), createdAt, status: 'recording' }));
    return send(res, 201, { id });
  }
  if ((g = p.match(/^\/api\/recordings\/([\w-]+)$/))) {
    const id = g[1], d = dir(id);
    if (m === 'GET') return send(res, 200, { ...(await readMeta(id)), transcript: await readText(path.join(d, 'transcript.txt')), minutes: await readText(path.join(d, 'minutes.md')) });
    if (m === 'DELETE') { await readMeta(id); await fsp.rm(d, { recursive: true, force: true }); return send(res, 200, { ok: true }); }
  }
  if ((g = p.match(/^\/api\/recordings\/([\w-]+)\/(chunk|finish|reprocess)$/)) && m === 'POST') {
    const id = g[1]; await readMeta(id);
    if (g[2] === 'chunk') {
      await new Promise((ok, ng) => req.pipe(fs.createWriteStream(path.join(dir(id), 'upload.webm'), { flags: 'a' })).on('finish', ok).on('error', ng));
      return send(res, 200, { ok: true });
    }
    processRecording(id); // 待たない。進捗は meta.status
    return send(res, 202, { ok: true });
  }
  if ((g = p.match(/^\/recordings\/([\w-]+)\/(recording\.webm|transcript\.txt|minutes\.md)$/)) && m === 'GET') return sendFile(req, res, path.join(dir(g[1]), g[2]));
  throw new HttpError(404, 'not found');
}

export const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // 拡張 (chrome-extension://) から叩く。tailnet 内にしか出さない前提
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();
  try { await route(req, res); } catch (e) { send(res, e.status || 500, { error: e.message }); }
});

// 再起動で途中になった処理は error にして、UI の「再処理」で拾わせる
for (const id of fs.readdirSync(DATA)) {
  const fp = path.join(DATA, id, 'meta.json');
  if (fs.existsSync(fp) && JSON.parse(fs.readFileSync(fp, 'utf8')).status === 'processing') await patchMeta(id, { status: 'error', error: 'interrupted by restart' });
}
server.listen(PORT, '0.0.0.0', () => console.log(`ai-meeting http://0.0.0.0:${server.address().port} data=${DATA} key=${KEY ? 'set' : 'MISSING'}`));
