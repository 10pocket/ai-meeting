# 話者分離: 16kHz モノラル wav → [{start,end,speaker}] の JSON と、話者ごとの声の特徴 (speaker embedding) の JSON。pyannote Community-1 (CPU)。
# モデルは初回に Hugging Face から取得する (HF_TOKEN と、モデルページでの利用条件への同意が必要)。HF_HOME に保存。
import json, sys, time, wave
import numpy as np
import torch
from pyannote.audio import Pipeline

wav_path, out_path, num_speakers, threads, emb_path = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
torch.set_num_threads(threads)
with wave.open(wav_path) as w:
    assert w.getframerate() == 16000 and w.getnchannels() == 1
    audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
pipe = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1")  # トークンは HF_TOKEN から読まれる
# num_speakers=-1 は人数を自動判定
result = pipe({"waveform": torch.from_numpy(audio).unsqueeze(0), "sample_rate": 16000},
              **({"num_speakers": num_speakers} if num_speakers > 0 else {}))
ann = result.exclusive_speaker_diarization  # 発話の重なりを排除した版 (文字起こしの区切りに向く)
label = lambda l: int(l.split("_")[-1])
json.dump([{"start": s.start, "end": s.end, "speaker": label(l)} for s, _, l in ann.itertracks(yield_label=True)], open(out_path, "w"))
# speaker_embeddings は speaker_diarization.labels() の順。発話が短すぎる話者は NaN になるので落とす
emb = result.speaker_embeddings if result.speaker_embeddings is not None else []
json.dump({str(label(l)): e.tolist() for l, e in zip(result.speaker_diarization.labels(), emb) if np.isfinite(e).all()}, open(emb_path, "w"))
