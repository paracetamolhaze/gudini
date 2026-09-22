# Gudini Threads: один образ для app (API + dashboard) и worker (очереди); команда задаётся в compose.
FROM node:22-bookworm-slim

# Шрифты с кириллицей для рендера переведённых картинок (sharp + librsvg берут их через fontconfig)
RUN apt-get update \
    && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Playwright нужен только контейнеру браузера X; здесь его движки качать не надо.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production \
    PORT=8600 \
    DATA_DIR=/app/data \
    FONT_DIR=/usr/share/fonts/truetype/dejavu
VOLUME ["/app/data"]
EXPOSE 8600

CMD ["node", "dist/src/index.js"]
