// Quant Research Lab — 数据源注册表：量化模块通过此处取得 Provider，不感知具体实现
// 默认 em（真实行情），断源/离线场景由调用方决定回退 demo。
import type { DataProvider } from "../types.ts";
import { demoProvider } from "./demo-provider.ts";

// em-provider 依赖服务端网络与 @/ 别名，动态引入以保持本模块在纯逻辑测试中可用
type EmLoader = () => DataProvider | Promise<DataProvider>;
let emLoader: EmLoader | null = null;

export function registerEmProvider(loader: EmLoader): void {
  emLoader = loader;
}

export async function getProvider(id?: string): Promise<DataProvider> {
  if (id === "demo") return demoProvider;
  if (id === "em" || !id) {
    if (!emLoader) throw new Error("EM Provider 未注册（仅服务端可用）");
    return emLoader();
  }
  throw new Error(`未知数据源：${id}（可用：em | demo）`);
}

export function listProviderIds(): string[] {
  return ["em", "demo"];
}

export { demoProvider };
