import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // P67 体检：仓库根在 D:\Zai\kairotrend-p1，但 node_modules 向上有 D:\Zai 的 package-lock.json，
  // Next 自动探测会把 workspace 根定到上层目录并每次启动警告「ignored package-lock.json」——显式钉住。
  outputFileTracingRoot: __dirname,
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // undici 用于 AI 上游的 ProxyAgent 出网，保持 Node 原生加载不打包
  serverExternalPackages: ["undici"],
  // 允许本机（含 ZCode 内置浏览器）访问 dev 资源（HMR/字体），否则 hydration 被拦截
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Webpack 模式（--webpack）在 instrumentation 编译阶段默认不解析 Node 内置模块，
  // 需要显式声明 external；turbopack 模式不受影响。
  webpack: (config, ctx) => {
    if (!ctx.isServer) {
      // 客户端打包允许 fs/path 被解析成空模块（2026-10-02 体检 P0）：
      // session.ts 里对 trade-date/em 的**服务端专用**动态 import 会形成客户端 chunk 边缘，
      // 那条链上的 fs/path 只是「要能通过构建」——浏览器里这条链永远不会被执行
      // （holiday flag 只在服务端路由里算），不 fallback 整站直接 500。
      config.resolve = {
        ...(config.resolve ?? {}),
        fallback: { ...((config.resolve as { fallback?: Record<string, boolean> } | undefined)?.fallback ?? {}), fs: false, path: false },
      };
      return config;
    }
    const builtins = require("node:module").builtinModules.filter((m: string) => !m.startsWith("_")).concat(["sqlite", "test", "sea"]);
    const ext: Record<string, string> = {
      ...(config.externalsType === "commonjs" ? {} : {}),
    };
    builtins.forEach((b) => { ext[b] = `commonjs ${b}`; ext[`node:${b}`] = `commonjs node:${b}`; });
    config.externals = [
      ...Array.isArray(config.externals) ? config.externals : [],
      ext,
    ];
    return config;
  },
};

export default nextConfig;
