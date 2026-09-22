// R9 钉：通达信 tdx-mcp 注册进工作台 MCP 层（配置唯一源 + 硬约束不漂移）
// 断言的是「登记形状」：uvx 绝对路径（spawn 无 shell）、mcp<2 版本钉（上游 import 崩点）、
// trusted=true（用户拍板接入），以及 data/mcp-config.json 与 store.ts 默认值两处一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd());
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "data/mcp-config.json"), "utf-8"));
const storeSrc = fs.readFileSync(path.join(ROOT, "src/lib/desk/store.ts"), "utf-8");

const tdx = (cfg.servers ?? []).find((s: { id: string }) => s.id === "tdx-mcp");

test("data/mcp-config.json 登记了 tdx-mcp，且 trusted=true（接入授权项）", () => {
  assert.ok(tdx, "配置里必须能找到 tdx-mcp");
  assert.equal(tdx.trusted, true, "不信任则 callTool 会 TRUST_REQUIRED 拦截，接入即授权");
});

test("命令与参数：uvx 绝对路径 + mcp<2 版本钉（丢了一个都起不来）", () => {
  assert.match(tdx.command, /uvx\.exe$/, "spawn 无 shell，PATH 查不到，必须绝对路径");
  assert.ok(tdx.args.includes("mcp<2"), "mcp 2.x 把 FastMCP 改名 MCPServer，tdx-mcp 0.2.4 不加钉必崩");
  assert.equal(tdx.env?.UV_CACHE_DIR, "D:\\Zai\\uv-cache", "缓存只写 D 盘");
});

test("store.ts 默认值与配置文件同源（浏览器新 profile 也能在设置页看到）", () => {
  assert.match(storeSrc, /id: "tdx-mcp"/);
  assert.match(storeSrc, /"--from", "tdx-mcp", "--with", "mcp<2", "tdx-mcp"/);
});

test("v3 一次性补种迁移：旧存档 MCP 列表按 id 判缺补 tdx-mcp，不挤掉 demo", () => {
  assert.match(storeSrc, /version: 3,/);
  // 只在「有数组且缺 tdx」时补种；没有该键走默认值（防止把 demo-market 挤丢）
  assert.match(storeSrc, /Array\.isArray\(state\.mcpServers\) && !state\.mcpServers\.some\(\(m\) => m\.id === "tdx-mcp"\)/);
});

test("诚实边界钉：symbol_zjlx 上游输出校验 bug 的口径说明在案", () => {
  assert.match(storeSrc, /symbol_zjlx[\s\S]{0,120}bug/, "资金流向工具不可当第二家资金口径，注释须在");
});
