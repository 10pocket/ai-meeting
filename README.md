# ai-meeting

自分が出席する Google Meet を Chrome 拡張で録画し、ローカルサーバーで文字起こし・議事録を作る。
配信は tailnet 内だけ (例: `https://ai-meeting.example.com`、Caddy 経由)。
**このサーバーに認証はありません。公開インターネットには出さないこと。**

```
Chrome 拡張 ──5秒ごとに webm を POST──▶ server.js ──▶ ~/ai-meeting/volume/<id>/
  (タブ音声+映像+マイク)                    │              recording.webm / transcript.txt / minutes.md
                                           ├─ ffmpeg: 音声を 5 分ごとの mp3 に分割
                                           ├─ OpenAI gpt-transcribe: 文字起こし ($0.0045/分)
                                           └─ OpenAI gpt-5-mini: 議事録 (概要/決定事項/アクション/論点/未決)
Web UI (/) : 一覧・再生・議事録・ダウンロード・再処理・削除。[hh:mm:ss] クリックで動画が飛ぶ。
```

依存パッケージなし (Node 24 の fetch / FormData / node:test)。ffmpeg だけコンテナに入れる。

## 常駐

undertone と同じ。docker compose ([compose.yaml](compose.yaml)) を systemd の user unit で起こす。

```sh
cp .env.example .env            # OPENAI_API_KEY を入れる
mkdir -p ~/ai-meeting/volume ~/.config/systemd/user
ln -s "$PWD/ai-meeting.service" ~/.config/systemd/user/ai-meeting.service
systemctl --user daemon-reload
systemctl --user enable --now ai-meeting
```

- `ai-meeting.service` の `WorkingDirectory` は、この作業コピーの置き場に合わせて書き換える。
- 出すのは `127.0.0.1:8790` だけ。認証は無いので Caddy より外に出さない。
- 状態: `systemctl --user status ai-meeting` / `journalctl --user -u ai-meeting -f`
- `.env` を変えたら `systemctl --user restart ai-meeting`

Caddy (`/etc/caddy/Caddyfile` の自分のドメインのブロック内に追加して `sudo systemctl reload caddy`):

```
	@ai-meeting host ai-meeting.example.com
	handle @ai-meeting {
		reverse_proxy 127.0.0.1:8790
	}
```

## Chrome 拡張

1. Web UI の「extension.zip をダウンロード」(`/extension.zip`) を展開し、`chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」で `extension` フォルダを選ぶ (この作業コピーの [extension/](extension) を直接選んでもよい)。
2. Meet のタブで拡張のアイコンを押す → 録画ページが別タブで開く (マイク許可を求められる)。
3. サーバー URL (初回のみ入力。以後は記憶) を確認して「録画開始」。録画ページは閉じない。タイトルは「作成日時 + 内容から LLM が付けた短い題」になる。
4. 「停止して送信」で終了。会議タブを閉じても止まる。数分後に Web UI に議事録が出る。

- 録るのは Meet タブに描画されている映像 (画面共有含む) と、タブの音声 + 自分のマイクを混ぜた 1 トラック。
- 録画中も相手の声は自分のスピーカーから聞こえる (AudioContext で流し直している)。
- 録画には参加者への告知・同意が要る。音声は OpenAI へ送る。

## 手元で動かす

```sh
OPENAI_API_KEY=... node server.js   # http://localhost:8790 、data/ に保存。ffmpeg が要る
node --test
```

## やっていないこと

- 話者分離。pyannote.audio をコンテナに足し、`audio/*.mp3` に当てて transcript と突き合わせる想定。
- 自分の声の別トラック送信 (上記と組で)。
- 無音境界での分割。固定 5 分なので境界で発言が割れることがある。
