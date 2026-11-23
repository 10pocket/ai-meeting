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
const MATCH = +(process.env.SPEAKER_MATCH_THRESHOLD || 0.55); // 声の特徴のコサイン類似度がこれ以上なら、過去に名前を付けた人と推定する
const MAX_CHUNK_SEC = 300; // 1回の文字起こしに渡す最大長 (25MB 上限に余裕を持たせる)
const PAD_SEC = 0.15; // 話者境界は数百ms ずれるので、前後に少し余白を付けて切る
// 概算料金 (USD)。既定は 2026-11 時点の公式価格 (gpt-transcribe / gpt-5.6-terra)。モデルや単価が変わったら .env で上書きする
// ponytail: 272K tokens 超の割増 (入力 2 倍・出力 1.5 倍) とキャッシュ割引は見ない。会議 1 本では届かない
const price = (k, d) => process.env[k] ? +process.env[k] : d;
const PRICE = { transcribePerMin: price('PRICE_TRANSCRIBE_PER_MIN', 0.0045), minutesIn: price('PRICE_MINUTES_INPUT_PER_1M', 2), minutesOut: price('PRICE_MINUTES_OUTPUT_PER_1M', 12) };
const USAGE = path.join(DATA, 'usage.jsonl'); // API 呼び出しの台帳。録画を消しても月次の集計に残す
const PUBLIC = path.join(import.meta.dirname, 'public');
const MINUTES_PROMPT = `あなたは会議の議事録作成者です。渡された文字起こし (発言ごとに [hh:mm:ss] 話者N: の形式) から、日本語で端的な Markdown 議事録を作ります。読み手は会議に出ていない人で、「何が決まり、誰が何をするか」を 1 分で把握したい。

1 行目は「# 」で始まる 20 文字以内のタイトル (内容が一目で分かるもの)。続けて次の順で書く。該当がない節は見出しごと省く (「なし」とは書かない):
## 概要 — 2 文以内。目的と結論だけ。
## 決定事項 — 決まったことだけ。議論中・提案止まりは含めない。
## アクションアイテム — 「内容 (担当: 話者N / 期限: 〜)」。担当・期限は文字起こしで分かるときだけ付け、推測しない。
## 論点 — 結論に影響した論点だけ、最大 5 項目。各項目の末尾に根拠の時刻を [hh:mm:ss] で 1 つ添える。
## 持ち越し — 未決のまま残った事項。

書き方:
- 箇条書きは 1 項目 1 行・60 文字以内、体言止め。前置き・経緯・感想・相づち・雑談は書かない。
- 同じ内容を複数の節に重ねて書かない (決定事項に書いたことは論点に書かない)。
- 全体で 600 文字程度を目安とし、会議が長くても項目を増やすより統合する。
- 文字起こしにない情報を補わない。
- 話者は必ず「話者N」と書き、名前に置き換えない (名前は利用者が画面で付ける)。話者分離の誤りで同じ人が別の話者になったり、別の人が混ざったりすることがあるので、取り違えが疑われる箇所は担当を断定しない。`;

fs.mkdirSync(DATA, { recursive: true });

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const dir = id => { if (!/^[\w-]+$/.test(id)) throw new HttpError(400, 'bad id'); return path.join(DATA, id); };
const readMeta = async id => JSON.parse(await fsp.readFile(path.join(dir(id), 'meta.json'), 'utf8').catch(() => { throw new HttpError(404, 'not found'); }));
const patchMeta = async (id, p) => { const m = { ...(await readMeta(id)), ...p }; await fsp.writeFile(path.join(dir(id), 'meta.json'), JSON.stringify(m, null, 2)); return m; };
const hms = s => [s / 3600, s / 60 % 60, s % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':');
const readText = fp => fsp.readFile(fp, 'utf8').catch(() => null);
const logUsage = e => fsp.appendFile(USAGE, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');
const readUsage = async () => ((await readText(USAGE)) || '').split('\n').filter(Boolean).map(l => JSON.parse(l));
async function dirSize(d) {
  const ents = await fsp.readdir(d, { recursive: true, withFileTypes: true }).catch(() => []);
  const sizes = await Promise.all(ents.filter(e => e.isFile()).map(e => fsp.stat(path.join(e.parentPath, e.name)).then(s => s.size, () => 0)));
  return sizes.reduce((a, b) => a + b, 0);
}
export function monthly(entries) { // 月ごと・API ごとの合計 USD。古い月から
  const m = {};
  for (const e of entries) { const k = stamp(e.at).slice(0, 7); (m[k] ??= { month: k, transcribe: 0, minutes: 0 })[e.api] += e.usd || 0; }
  return Object.values(m).sort((a, b) => a.month.localeCompare(b.month));
}
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
  const body = JSON.stringify({ model: MINUTES_MODEL, verbosity: 'low', messages: [ // verbosity: 短く書かせる (GPT-5 系の Chat Completions の引数)
    { role: 'system', content: MINUTES_PROMPT },
    { role: 'user', content: transcript },
  ] });
  const j = await openai('/chat/completions', body, { 'Content-Type': 'application/json' });
  return { text: j.choices[0].message.content, usage: j.usage };
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
// ---- 話者の推定 ----
const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; } return d / Math.sqrt(x * y); };
// voices: { 話者N: 特徴 }、profiles: [{ name, vec }] (人が確定した名前だけ)。似ている順に 1 人 1 名で当てる
export function guessSpeakers(voices, profiles, threshold = MATCH) {
  const pairs = Object.entries(voices).flatMap(([k, v]) => profiles.map(p => ({ k, name: p.name, sim: cosine(v, p.vec) })))
    .filter(p => p.sim >= threshold).sort((a, b) => b.sim - a.sim);
  const out = {}, used = new Set();
  for (const p of pairs) if (!(p.k in out) && !used.has(p.name)) { out[p.k] = { name: p.name, sim: Math.round(p.sim * 100) / 100 }; used.add(p.name); }
  return out;
}
async function profiles(exceptId) { // 過去の録画で、人が名前を付けた話者の特徴。推定のまま確定していない名前は使わない (誤りを広げないため)
  // ponytail: 毎回全録画の voices.json を読む。録画が数千になったら集計をキャッシュする
  const out = [];
  for (const id of await listIds()) {
    if (id === exceptId) continue;
    const meta = await readMeta(id), voices = JSON.parse(await readText(path.join(DATA, id, 'voices.json')) || '{}');
    for (const [k, name] of Object.entries(meta.speakers || {})) if (voices[k] && !meta.guessed?.[k]) out.push({ name, vec: voices[k] });
  }
  return out;
}
async function processRecording(id) {
  const d = dir(id);
  try {
    const meta = await patchMeta(id, { status: 'processing', error: null });
    if (!KEY) throw new Error('OPENAI_API_KEY is not set');
    const upload = path.join(d, 'upload.webm'), video = path.join(d, 'recording.webm');
    if (fs.existsSync(upload)) { // MediaRecorder の追記 webm は長さも cue も無く seek できない。書き直すついでに 480p・5fps に落とす (会議なら 1 時間 20MB 前後、元の約 1/24)
      await exec('ffmpeg', ['-y', '-i', upload, '-vf', 'scale=-2:480,fps=5', '-c:v', 'libvpx-vp9', '-crf', '38', '-b:v', '0', '-row-mt', '1', '-cpu-used', '5', '-c:a', 'libopus', '-b:a', '48k', video], { timeout: 3600e3 });
      await fsp.unlink(upload);
    }
    const wav = path.join(d, 'audio.wav'), seg = path.join(d, 'audio');
    await exec('ffmpeg', ['-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', wav]);
    const duration = (fs.statSync(wav).size - 44) / 32000; // 16kHz 16bit モノラル
    let chunks, warning = null, emb = {};
    try { // 話者ごとの発言単位に切る。失敗しても文字起こしは止めず、話者なしで固定長に切る
      await exec('python3', [path.join(import.meta.dirname, 'diarize.py'), wav, path.join(d, 'diarization.json'), SPEAKERS, '6', path.join(d, 'embeddings.json')], { timeout: 3600e3 });
      chunks = makeChunks(JSON.parse(await fsp.readFile(path.join(d, 'diarization.json'), 'utf8')));
      emb = JSON.parse(await fsp.readFile(path.join(d, 'embeddings.json'), 'utf8'));
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
    // 話者N ごとの声の特徴を残し、過去に名前を付けた人と照らして推定する。人が付けた名前は上書きしない
    const voices = Object.fromEntries([...names].filter(([n]) => emb[n]).map(([n, k]) => [k, emb[n]]));
    await fsp.writeFile(path.join(d, 'voices.json'), JSON.stringify(voices));
    const cur = await readMeta(id), confirmed = Object.fromEntries(Object.entries(cur.speakers || {}).filter(([k]) => !cur.guessed?.[k]));
    const guesses = Object.entries(guessSpeakers(Object.fromEntries(Object.entries(voices).filter(([k]) => !confirmed[k])), (await profiles(id)).filter(p => !Object.values(confirmed).includes(p.name))));
    await patchMeta(id, { speakers: { ...confirmed, ...Object.fromEntries(guesses.map(([k, g]) => [k, g.name])) }, guessed: Object.fromEntries(guesses.map(([k, g]) => [k, g.sim])) });
    // ponytail: 秒数×単価で概算。途中のチャンクで失敗した分は記録しない
    const sec = chunks.reduce((a, c) => a + Math.min(c.end + PAD_SEC, duration) - Math.max(c.start - PAD_SEC, 0), 0);
    await logUsage({ id, api: 'transcribe', model: TRANSCRIBE_MODEL, seconds: Math.round(sec), usd: sec / 60 * PRICE.transcribePerMin });
    const { text: minutes, usage: u } = await summarize(transcript);
    const inT = u?.prompt_tokens || 0, outT = u?.completion_tokens || 0;
    await logUsage({ id, api: 'minutes', model: MINUTES_MODEL, inputTokens: inT, outputTokens: outT,
      usd: (inT * PRICE.minutesIn + outT * PRICE.minutesOut) / 1e6 });
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
const listIds = async () => (await fsp.readdir(DATA)).filter(id => fs.existsSync(path.join(DATA, id, 'meta.json')));
const allNames = async () => [...new Set((await Promise.all((await listIds()).map(readMeta))).flatMap(r => Object.values(r.speakers || {})))].sort(); // 話者名の入力履歴
async function route(req, res) {
  const p = new URL(req.url, 'http://x').pathname, m = req.method;
  let g;
  if (p === '/' && m === 'GET') return sendFile(req, res, path.join(PUBLIC, 'index.html'));
  if (p === '/extension.zip' && m === 'GET') { // Chrome 拡張の配布。落として chrome://extensions に読み込む
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="ai-meeting-extension.zip"' });
    return spawn('zip', ['-qr', '-', 'extension'], { cwd: import.meta.dirname }).stdout.pipe(res);
  }
  if (p === '/api/recordings' && m === 'GET') {
    const list = await Promise.all((await listIds()).map(readMeta));
    return send(res, 200, list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  if (p === '/api/admin' && m === 'GET') {
    const [total, hf] = await Promise.all([dirSize(DATA), dirSize(path.join(DATA, 'hf'))]);
    return send(res, 200, { months: monthly(await readUsage()), storage: { recordings: total - hf, models: hf } });
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
    if (m === 'GET') return send(res, 200, { ...(await readMeta(id)), names: await allNames(), bytes: await dirSize(d), usage: (await readUsage()).filter(e => e.id === id), transcript: await readText(path.join(d, 'transcript.txt')), minutes: await readText(path.join(d, 'minutes.md')) });
    if (m === 'DELETE') { await readMeta(id); await fsp.rm(d, { recursive: true, force: true }); return send(res, 200, { ok: true }); }
  }
  if ((g = p.match(/^\/api\/recordings\/([\w-]+)\/speakers$/)) && m === 'POST') { // { "話者1": "山田", … } を今の名前に重ねる。空文字で解除。送った話者は「確定」になる
    const meta = await readMeta(g[1]);
    let body; try { body = JSON.parse(await new Response(req).text()); } catch { throw new HttpError(400, 'bad json'); }
    if (!body || typeof body !== 'object' || Object.entries(body).some(([k, v]) => !/^話者\d+$/.test(k) || typeof v !== 'string' || v.length > 50)) throw new HttpError(400, 'bad speakers');
    const speakers = Object.fromEntries(Object.entries({ ...meta.speakers, ...body }).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    const guessed = Object.fromEntries(Object.entries(meta.guessed || {}).filter(([k]) => !(k in body)));
    return send(res, 200, await patchMeta(g[1], { speakers, guessed }));
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
