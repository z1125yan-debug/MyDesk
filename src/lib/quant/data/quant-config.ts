// Quant Research Lab — 数据源配置（服务端）
// 读取环境变量 CHINA_STOCK_MCP_URL（优先）→ QUANT_MCP_URL → data/quant-config.json
// 结构：{ "mcp": { "url": "https://..." } }
import fs from "fs";
import path from "path";
import type { QuantConfig } from "./types";

const CONFIG_FILE = path.join(process.cwd(), "data", "quant-config.json");

let cachedConfig: QuantConfig | null = null;

export function loadQuantConfig(): QuantConfig {
  if (cachedConfig) return cachedConfig;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      cachedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as QuantConfig;
    }
  } catch {
    // 解析失败视为无配置
  }
  cachedConfig = cachedConfig ?? {};
  return cachedConfig;
}

export function mcpUrl(): string {
  return process.env.CHINA_STOCK_MCP_URL || process.env.QUANT_MCP_URL || loadQuantConfig().mcp?.url || "";
}
