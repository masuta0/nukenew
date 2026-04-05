FROM node:20-bullseye-slim

WORKDIR /app

# Install runtime dependencies and ffmpeg
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Download yt-dlp binary to /usr/local/bin so it's available to all users
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp

ENV PATH=/usr/local/bin:$PATH
ENV NODE_ENV=production

# Install dependencies (use package-lock if present for reproducible builds)
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --legacy-peer-deps; else npm install --omit=dev --legacy-peer-deps; fi

# Copy app sources
# 変更後
COPY . .
RUN mkdir -p /app/data /app/app-data /app/logs && chown -R node:node /app
USER node
EXPOSE 3000


CMD ["node", "index.js"]
