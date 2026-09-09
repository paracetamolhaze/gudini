import type { NextConfig } from "next";

// вкладка /clipy — отдельный контейнер (см. docker-compose.yml, сервис clipy); сайт проксирует
// её к себе, чтобы дома по :3000 и снаружи через Caddy адрес был один и тот же.
// Rewrites вшиваются при `next build`: в Docker это production и сервис clipy, при `npm run dev` — localhost.
const clipyUrl = (process.env.CLIPY_URL || (process.env.NODE_ENV === "production" ? "http://clipy:8500" : "http://127.0.0.1:8500")).replace(/\/$/, "");

const nextConfig: NextConfig = {
  outputFileTracingRoot: __dirname,
  experimental: {
    serverActions: { bodySizeLimit: "2gb" },
    // Прокси на /clipy буферизует тело запроса в памяти и по умолчанию режет его на 10 МБ:
    // загрузка видео крупнее падала с «socket hang up». Гигабайта хватает любому короткому ролику.
    middlewareClientMaxBodySize: "1gb",
  },
  async rewrites() {
    return [
      { source: "/clipy", destination: `${clipyUrl}/clipy` },
      { source: "/clipy/:path*", destination: `${clipyUrl}/clipy/:path*` },
    ];
  },
};

export default nextConfig;
