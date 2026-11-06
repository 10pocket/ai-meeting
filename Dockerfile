# node:24-slim に ffmpeg を足すだけ。コードは bind mount するので焼き込まない。
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg zip && rm -rf /var/lib/apt/lists/*
