FROM node:20-bullseye-slim

WORKDIR /app

# Install runtime dependencies and ffmpeg
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates ffmpeg build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

# Download yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp

ENV PATH=/usr/local/bin:$PATH
ENV NODE_ENV=production

# --- TensorFlow & Node.js Optimization ---
ENV TF_CPP_MIN_LOG_LEVEL=2
ENV TF_ENABLE_ONEDNN_OPTS=0
ENV NODE_OPTIONS="--max-old-space-size=2048"

# Install dependencies
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --legacy-peer-deps; else npm install --omit=dev --legacy-peer-deps; fi

# Copy app sources
COPY . .

# --- 🚀 [ULTIMATE FIX] モデルファイルの完全ダウンロード ---
# 1. モデル保存用ディレクトリを作成
RUN mkdir -p /app/utils/models && \
    MODEL_BASE_URL="https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights" && \
    # 2. 全ての manifest.json (設計図) をダウンロード
    for MODEL in ssd_mobilenetv1_model face_landmark_68_model face_recognition_model face_expression_model tiny_face_detector_model; do \
        curl -L "${MODEL_BASE_URL}/${MODEL}-weights_manifest.json" -o "/app/utils/models/${MODEL}-weights_manifest.json"; \
    done && \
    # 3. 【重要】ssd_mobilenetv1 は分割ファイル (shard1, shard2) の両方が必要
    curl -L "${MODEL_BASE_URL}/ssd_mobilenetv1_model-shard1" -o "/app/utils/models/ssd_mobilenetv1_model-shard1" && \
    curl -L "${MODEL_BASE_URL}/ssd_mobilenetv1_model-shard2" -o "/app/utils/models/ssd_mobilenetv1_model-shard2" && \
    # 4. それ以外のモデルは標準の .bin ファイルをダウンロード
    for MODEL in face_landmark_68_model face_recognition_model face_expression_model tiny_face_detector_model; do \
        curl -L "${MODEL_BASE_URL}/${MODEL}.bin" -o "/app/utils/models/${MODEL}.bin"; \
    done

# Create necessary directories and set permissions
RUN mkdir -p /app/data /app/app-data /app/logs && chown -R node:node /app
USER node
EXPOSE 3000

CMD ["node", "index.js"]
