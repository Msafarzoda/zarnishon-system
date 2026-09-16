import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  /**
   * A second dev server — pointed at a throwaway database, to try something out without
   * touching the factory's own — must not share `.next` with the one the staff are using:
   * two servers writing one build directory clobber each other's CSS.
   */
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Station screens run on the factory LAN and on tablets; keep the build honest.
  typedRoutes: false,
  experimental: {
    serverActions: { bodySizeLimit: "4mb" }, // weighbridge indicator photos
  },
  /**
   * `serialport` is a native addon: it must be required at runtime from node_modules, not
   * traced and bundled. Bundling it produces a build that fails to open the port at the
   * one moment nobody is watching the logs.
   */
  serverExternalPackages: ["serialport", "@serialport/bindings-cpp"],
};

export default config;
