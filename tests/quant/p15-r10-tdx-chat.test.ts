// R10 钉：通达信三件套开放给对话 AI（模型自取、人话步骤条、新闻结合纪律、不动清单守界）
// 全部是源码钉（零 IO）：工具本体在 chat-tools（带网络/prisma 的重模块），测试按 P13 先例读源码断言形状。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const chatTools = fs.readFileSync(path.join(ROOT, "src/lib/desk/chat-tools.ts"), "utf-8");
const route = fs.readFileSync(path.join(ROOT, "src/app/api/ai/chat/route.ts"), "utf-8");
const streamCore = fs.readFileSync(path.join(ROOT, "src/lib/desk/chat-stream-core.ts"), "utf-8");
const skills = fs.readFileSync(path.join(ROOT, "src/lib/desk/skills-core.ts"), "utf-8");

test("三件 tdx 工具注册进 TOOLS（模型看得见才算开放），desc 自带口径边界", () => {
  for (const n of ["tdx_market_overview", "tdx_quotes", "tdx_kline"]) {
    assert.ok(chatTools.includes(`name: "${n}"`), `${n} 已注册`);
  }
  assert.match(chatTools, /无资金流读数/, "概况工具 desc 明说没有资金口径，防模型拿它答资金");
  assert.match(chatTools, /资金流向仍用 stock_fund_flow/, "行情工具 desc 把资金问题指回东财口径");
  assert.match(chatTools, /与东财口径互为交叉核对/, "定位是第二家核对，不是替换东财");
});

test("走 MCP 通道不建第二个行情客户端；冷启动惰性拉起且并发只放一个在途", () => {
  assert.match(chatTools, /import \{ callTool as mcpCallTool, listServers, startServer \} from "\.\/mcp-manager"/);
  assert.match(chatTools, /tdxBooting \?\?= probe\(\)/, "启动在途去重：并行工具调用不能互相 kill 子进程");
  assert.match(chatTools, /mcpCallTool\("tdx-mcp"/, "服务器 id 用登记表里的 tdx-mcp");
});

test("失败面全是 missing，不拿空数组/0 冒充没数据", () => {
  // 三个工具各自的失败出口都要么是 missing 要么是启动原因
  const block = chatTools.slice(chatTools.indexOf("// ---------- R10 通达信 MCP 工具"), chatTools.indexOf("export interface ChatTool"));
  const missingHits = (block.match(/return \{ missing:/g) ?? []).length;
  assert.ok(missingHits >= 9, `每个取数失败/无返回/上游报错分支都回 missing（实数 ${missingHits} 处）`);
  assert.doesNotMatch(block, /return \{ .*: \[\] \}/, "不返回空数组冒充");
});

test("提示词纪律：交叉核对各报各出身 + 资金不认通达信 + 结论必须挂新闻", () => {
  assert.match(route, /通达信三件套（tdx_market_overview \/ tdx_quotes \/ tdx_kline）/, "第 6 条在");
  assert.match(route, /禁止平均、禁止混成一家/, "两家数字不一致的口径钉死");
  assert.match(route, /通达信系没有资金流读数/, "资金类问题指回东财/同花顺");
  assert.match(route, /禁止编一个通达信数字/, "起不来时禁编");
  // 本轮在消息面之前插了一条「五档盘口必须读懂再写」（第 8 条），消息面顺延为第 9 条
  assert.match(route, /9\. 结论必须结合消息面/, "消息面纪律在（用户口径：结合新闻说）");
  assert.match(route, /暂无相关新闻，本轮是纯行情数据判断/, "没新闻要自报纯行情判断");
  // 用户实测「数据侧有五档，AI 分析里永远没有」：盘口不但要预取到，还必须禁止原样罗列档位
  assert.match(route, /8\. 五档盘口（stock_depth）必须读懂后再写进分析/, "盘口纪律：读懂再写，禁止原样罗列");
  assert.match(route, /禁止原样罗列档位/, "不许把买一/卖一抄进正文当分析");
});

test("步骤条人话：新工具标签在本层前置查表，chat-stream-core（不动清单）零沾染", () => {
  // R10 扩容后这张表不只装 tdx：改名 STEP_LABELS_OVERRIDE，tdx 三件 + stock_news 都在里面
  assert.match(route, /const STEP_LABELS_OVERRIDE: Record<string, string> = \{/);
  assert.match(route, /STEP_LABELS_OVERRIDE\[c\.name\] \?\? stepLabelFor\(/);
  assert.doesNotMatch(streamCore, /tdx_|stock_news/, "不动清单：没往 chat-stream-core 里加任何新键");
});

test("不进自动调度预取表（同 P13 candidate_pool 先例）：冷启动 ~4s 不配让每轮行情查询等它", () => {
  assert.doesNotMatch(skills, /tdx_/, "BUILTIN_SKILLS 无 tdx 项 = 永不预取，只有模型自取");
});

test("代码→市场号映射与解包容错（形状钉）", () => {
  assert.ok(chatTools.includes("if (/^(6|9|5)/.test(code)) return 1;"), "沪市段 6/9/5 → market 1");
  assert.ok(chatTools.includes("if (/^(4|8)/.test(code)) return 2;"), "北交所段 4/8 → market 2");
  assert.match(chatTools, /period: 4/, "日K 固定 period 4=日线、不复权");
  assert.match(chatTools, /startsWith\("Error executing tool"\)/, "上游工具报错文本按 _error 接住，不静默丢");
});
