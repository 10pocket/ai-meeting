const q = new URLSearchParams(location.search);
const $ = s => document.querySelector(s);
// kind: 'rec' 録画中 / 'err' エラー / 'ok' 完了。href があれば文末にリンクを付ける
const status = (text, kind = '', href) => {
  const el = $('#status'); el.textContent = text; el.className = kind;
  if (href) { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '議事録のページを開く'; el.append(' ', a); }
};
let rec, id, server, queue = Promise.resolve(), stream, startedAt;

(async () => {
  $('#server').value = (await chrome.storage.local.get('server')).server || '';
  try {
    $('#target').textContent = '録画対象タブ: ' + q.get('title');
    // streamId は数秒で失効するので、開いた直後に getUserMedia に渡す
    const src = { chromeMediaSource: 'tab', chromeMediaSourceId: q.get('streamId') };
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: src },
      video: { mandatory: { ...src, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 15 } },
    });
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const tabSrc = ctx.createMediaStreamSource(tabStream);
    tabSrc.connect(ctx.destination); // キャプチャするとタブの音が止まるので、自分のスピーカーへ流し直す
    const mix = ctx.createMediaStreamDestination(); // ponytail: タブ音声とマイクを1トラックに混ぜる。話者分離で自分だけ確実に識別したくなったら別トラックで送る
    tabSrc.connect(mix); ctx.createMediaStreamSource(mic).connect(mix);
    stream = new MediaStream([...tabStream.getVideoTracks(), ...mix.stream.getAudioTracks()]);
    tabStream.getVideoTracks()[0].onended = () => rec?.state === 'recording' && stop(); // 会議タブが閉じられた
    status('準備ができました。「録画を開始」を押してください。');
    $('#start').disabled = false;
  } catch (e) { status('会議タブを取得できませんでした: ' + e.message + '。会議のタブで拡張のアイコンを押し直してください。', 'err'); }
})();

$('#start').onclick = async () => {
  server = $('#server').value.trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(server)) return status('サーバーの URL を入力してください。例: https://ai-meeting.example.com', 'err');
  await chrome.storage.local.set({ server });
  try {
    const r = await fetch(server + '/api/recordings', { method: 'POST' });
    ({ id } = await r.json());
  } catch (e) { return status('サーバーに接続できません: ' + e.message + '。URL を確認してください。', 'err'); }
  rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 1_000_000 });
  rec.ondataavailable = e => { if (e.data.size) queue = queue.then(() => fetch(`${server}/api/recordings/${id}/chunk`, { method: 'POST', body: e.data })).catch(e => status('送信に失敗しました: ' + e.message + '。ネットワークを確認してください。', 'err')); };
  rec.onstop = async () => {
    await queue;
    await fetch(`${server}/api/recordings/${id}/finish`, { method: 'POST' });
    stream.getTracks().forEach(t => t.stop());
    status('送信しました。サーバーで文字起こしと議事録を作っています。', 'ok', `${server}/#${id}`);
  };
  rec.start(5000); // 5秒ごとに送る。タブが落ちても直前までは残る
  startedAt = Date.now();
  $('#start').disabled = true; $('#stop').disabled = false;
  setInterval(() => rec.state === 'recording' && status(`● 録画中 ${new Date(Date.now() - startedAt).toISOString().slice(11, 19)}`, 'rec'), 1000);
};
function stop() { rec.stop(); $('#stop').disabled = true; status('停止しました。送信しています…'); }
$('#stop').onclick = stop;
onbeforeunload = e => { if (rec?.state === 'recording') { e.preventDefault(); e.returnValue = ''; } };
