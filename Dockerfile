FROM node:20-bullseye-slim

WORKDIR /app

# Install runtime dependencies and ffmpeg
# build-essentialを追加し、ネイティブモジュールのビルド失敗を防止
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates ffmpeg build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

# Download yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp

ENV PATH=/usr/local/bin:$PATH
ENV NODE_ENV=production

# --- TensorFlow & Node.js Optimization ---
# TF_CPP_MIN_LOG_LEVEL=2: INFOとWARNINGログを非表示にし、エラーのみ表示させる
# TF_ENABLE_ONEDNN_OPTS=0: エラーログに出ていたoneDNNの警告を抑制
ENV TF_CPP_MIN_LOG_LEVEL=2
ENV TF_ENABLE_ONEDNN_OPTS=0
# メモリ制限を緩和し、TensorFlowによるメモリ不足(OOM)クラッシュを軽減
ENV NODE_OPTIONS="--max-old-space-size=2048"

# Install dependencies
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --legacy-peer-deps; else npm install --omit=dev --legacy-peer-deps; fi

# Copy app sources
COPY . .

# --- Bug Fix: Manifest File Extension Auto-Fix ---
# モデルファイルに .json が付いていない場合に自動的に付与する安全装置
RUN find /app/utils/models -type f -name "*_manifest" ! -name "*.json" -exec mv {} {}.json \;

# Create necessary directories and set permissions
RUN mkdir -p /app/data /app/app-data /app/logs && chown -R node:node /app
USER node
EXPOSE 3000

CMD ["node", "index.js"]
