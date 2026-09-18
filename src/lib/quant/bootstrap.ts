// Quant Research Lab — 服务端引导（每个 quant API 路由入口调用，幂等）
// 负责：注册 EM 数据源实现、绑定任务持久化快照。不改任何现有模块。
import { registerEmProvider } from "./data/index.ts";
import { emProvider } from "./data/em-provider";
import { bindJobPersistence } from "./jobs/registry.ts";
import { makeJobPersistHook } from "./store";

interface G {
  __quantBootstrapped?: boolean;
}
const g = globalThis as unknown as G;

export function quantBootstrap(): void {
  if (g.__quantBootstrapped) return;
  registerEmProvider(() => emProvider);
  bindJobPersistence(makeJobPersistHook());
  g.__quantBootstrapped = true;
}
