// Quant Research Lab — 服务端引导（每个 quant API 路由入口调用，幂等）
// 负责：注册 EM / MCP 数据源实现、绑定任务持久化快照。不改任何现有模块。
// 注意：registerProvider 必须与 API 路由使用同一种模块说明符（@/ 别名或无扩展名相对路径）。
// Turbopack 会把 "./data/index.ts" 与 "@/lib/quant/data/index" 视为两个模块实例，
// 混用会导致 Provider 注册进另一个实例（症状："EM Provider 未注册"）。
import { registerProvider } from "./data/index";
import { emProvider } from "./data/em-provider";
import { mcpProvider, configureMcpProvider, mcpConfigured } from "./data/mcp-provider";
import { mcpUrl } from "./data/quant-config";
import { bindJobPersistence } from "./jobs/registry.ts";
import { makeJobPersistHook } from "./store";

interface G {
  __quantBootstrapped?: boolean;
}
const g = globalThis as unknown as G;

export function quantBootstrap(): void {
  if (!g.__quantBootstrapped) {
    registerProvider("em", () => emProvider);
    registerProvider("mcp", () => {
      if (!mcpConfigured()) configureMcpProvider(mcpUrl());
      return mcpProvider;
    });
    bindJobPersistence(makeJobPersistHook());
    g.__quantBootstrapped = true;
  }
  // 幂等：每次调都确保 MCP 客户端已构造（fundamental/signals 等直接调 fetchMcp* 不走 listUniverse 工厂）
  if (!mcpConfigured()) configureMcpProvider(mcpUrl());
}
