# 話者分離: 16kHz モノラル wav → [{start,end,speaker}] の JSON。pyannote Community-1 (CPU)。
# モデルは初回に Hugging Face から取得する (HF_TOKEN と、モデルページでの利用条件への同意が必要)。HF_HOME に保存。
import json, sys, time, wave
import numpy as np
import torch
from pyannote.audio import Pipeline

wav_path, out_path, num_speakers, threads = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
torch.set_num_threads(threads)
with wave.open(wav_path) as w:
    assert w.getframerate() == 16000 and w.getnchannels() == 1
    audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
pipe = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1")  # トークンは HF_TOKEN から読まれる
# num_speakers=-1 は人数を自動判定
result = pipe({"waveform": torch.from_numpy(audio).unsqueeze(0), "sample_rate": 16000},
              **({"num_speakers": num_speakers} if num_speakers > 0 else {}))
ann = result.exclusive_speaker_diarization  # 発話の重なりを排除した版 (文字起こしの区切りに向く)
json.dump([{"start": s.start, "end": s.end, "speaker": int(l.split("_")[-1])} for s, _, l in ann.itertracks(yield_label=True)], open(out_path, "w"))
