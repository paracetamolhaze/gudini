import type { NextConfig } from "next";

// вкладка /clipy — отдельный контейнер (см. docker-compose.yml, сервис clipy); сайт проксирует
// её к себе, чтобы дома по :3000 и снаружи через Caddy адрес был один и тот же.
// Rewrites вшиваются при `next build`: в Docker это production и сервис clipy, при `npm run dev` — localhost.
const clipyUrl = (process.env.CLIPY_URL || (process.env.NODE_ENV === "production" ? "http://clipy:8500" : "http://127.0.0.1:8500")).replace(/\/$/, "");

const nextConfig: NextConfig = {
  outputFileTracingRoot: __dirname,
  experimental: {
    serverActions: { bodySizeLimit: "2gb" },
  },
  async rewrites() {
    return [
      { source: "/clipy", destination: `${clipyUrl}/clipy` },
      { source: "/clipy/:path*", destination: `${clipyUrl}/clipy/:path*` },
    ];
  },
};

export default nextConfig;
