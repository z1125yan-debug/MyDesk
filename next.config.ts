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
  // Webpack 模式（--webpack）在 instrumentation 编译阶段默认不解析 Node 内置模块，
  // 需要显式声明 external；turbopack 模式不受影响。
  webpack: (config, ctx) => {
    if (!ctx.isServer) return config;
    const builtins = [
      "fs", "path", "os", "http", "https", "net", "tls", "stream", "buffer",
      "events", "url", "util", "crypto", "assert", "child_process", "dns",
      "zlib", "querystring", "tty", "module", "vm", "worker_threads", "perf_hooks",
    ];
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
