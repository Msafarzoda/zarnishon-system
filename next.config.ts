import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Station screens run on the factory LAN and on tablets; keep the build honest.
  typedRoutes: false,
  experimental: {
    serverActions: { bodySizeLimit: "4mb" }, // weighbridge indicator photos
  },
};

export default config;
