# node:24-slim に ffmpeg と話者分離 (python + pyannote.audio、CPU 版 torch) を足す。コードは bind mount するので焼き込まない。
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg zip python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir torch torchaudio --extra-index-url https://download.pytorch.org/whl/cpu \
 && /opt/venv/bin/pip install --no-cache-dir pyannote.audio numpy
ENV PATH="/opt/venv/bin:$PATH"
