import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: __dirname,
  experimental: {
    serverActions: { bodySizeLimit: "2gb" },
  },
};

export default nextConfig;
