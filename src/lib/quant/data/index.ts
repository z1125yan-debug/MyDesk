// Quant Research Lab — 数据源注册表：量化模块通过此处取得 Provider，不感知具体实现
// 默认 em（腾讯/东财直连），mcp（ModelScope china-stock-mcp）为第二真实源，
// demo（确定性演示）为离线回退。断源场景由调用方决定回退顺序。
import type { DataProvider } from "../types.ts";
import { demoProvider } from "./demo-provider.ts";
import { mcpUrl } from "./quant-config";

// em-provider / mcp-provider 依赖服务端网络与 @/ 别名，动态引入以保持本模块在纯逻辑测试中可用
type Loader = () => DataProvider | Promise<DataProvider>;
const loaders: Record<string, Loader | null> = { em: null, mcp: null };

export function registerProvider(id: "em" | "mcp", loader: Loader): void {
  loaders[id] = loader;
}

export async function getProvider(id?: string): Promise<DataProvider> {
  if (id === "demo") return demoProvider;
  const key = id ?? "em";
  if (key === "mcp") {
    if (!loaders.mcp) throw new Error("MCP Provider 未注册（仅服务端可用）");
    return loaders.mcp();
  }
  if (key === "em" || key === "") {
    if (!loaders.em) throw new Error("EM Provider 未注册（仅服务端可用）");
    return loaders.em();
  }
  throw new Error(`未知数据源：${id}（可用：em | mcp | demo）`);
}

export function listProviderIds(): string[] {
  return ["em", "mcp", "demo"];
}

export { demoProvider };
void mcpUrl; // 配置读取在 bootstrap 中使用；此处保留引用避免误删
