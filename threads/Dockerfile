# Gudini Threads: один образ для app (API + dashboard) и worker (очереди); команда задаётся в compose.
FROM node:22-bookworm-slim

# Шрифты с кириллицей для рендера переведённых картинок (sharp + librsvg берут их через fontconfig)
RUN apt-get update \
    && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pg_dump для ночного бэкапа: воркер не может зайти в соседний контейнер, дамп делает сам.
# Сервер — postgres:17, а штатный postgresql-client в bookworm пятнадцатый и дампить базу новее себя
# отказывается, поэтому клиент 17 ставим из репозитория PGDG.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gnupg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-17 \
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
