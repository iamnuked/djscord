import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        hostname: "cdn.discordapp.com",
        pathname: "/avatars/**",
        protocol: "https",
      },
    ],
  },
};

export default nextConfig;
