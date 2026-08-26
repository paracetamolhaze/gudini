FROM node:22-bookworm-slim

# ffmpeg для монтажа, fonts-liberation — метрический аналог Arial для субтитров (libass)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# next start сам использует переменную PORT (Railway задаёт её автоматически)
CMD ["npm", "start"]
