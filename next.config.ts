import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // undici 用于 AI 上游的 ProxyAgent 出网，保持 Node 原生加载不打包
  serverExternalPackages: ["undici"],
  // 允许本机（含 ZCode 内置浏览器）访问 dev 资源（HMR/字体），否则 hydration 被拦截
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
