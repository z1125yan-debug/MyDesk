// P35 稳智对齐：工具真实归属阶段（phase_key）由生产方显式发出，前端优先用它。
//
// 背景（稳智逆向）：稳智 agentStepTimeline 的每个工具步骤自带 phase_key，
// 按工具本身归属标（如 a_share_query_realtime_quote→external_data、duckdb_query→local_data），
// 不是按文案猜。本仓库 P27 消费者（decode + groupStepsByPhase）已就绪，但**从来没有生产方**：
//   - 后端 route.ts 发 step 事件不带 phase_key
//   - 自动调度 dispatch-core 造预取 step 也不带
// → 前端只能靠 classifyStep 猜，出现「🔬 综合分析」永远空（没一个步骤能命中 research 关键词）。
//
// P35 补上生产方：工具注册表（chat-tools.TOOLS[i].phase）登记每个工具**真实归属**的阶段，
// 路由与调度都读 phaseOfTool 填 step.phase_key。
//
// 测试分两类（对齐 P13/P15 先例）：
//   - 纯核直跑：agent-phases-core.deriveAgentPhases 的 phase_key 优先口径
//   - 源码形状钉：chat-tools 的 phase 表（服务层带 @/ 与 IO，Node 直跑解析不了别名，读源码断言）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deriveAgentPhases, classifyStep } from "../../src/lib/desk/agent-phases-core.ts";
import type { StepInfo } from "../../src/lib/desk/chat-core.ts";

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf-8");
const chatTools = read("src/lib/desk/chat-tools.ts");
const route = read("src/app/api/ai/chat/route.ts");
const dispatchCore = read("src/lib/desk/dispatch-core.ts");
const sceneDispatch = read("src/lib/desk/scene-dispatch.ts");

function msg(content = "回答内容", streaming = false) {
  return { content, streaming };
}

/** 从 chat-tools 的 TOOLS 块里取一个工具真实标的 phase（按 name 定位到下一个 name 之前的那段） */
const TOOLS_BLOCK = chatTools.slice(chatTools.indexOf("export const TOOLS"), chatTools.indexOf("export const TOOL_NAMES"));
function declaredPhase(tool: string): string | null {
  const at = TOOLS_BLOCK.indexOf(`name: "${tool}"`);
  if (at < 0) return null;
  const after = TOOLS_BLOCK.slice(at + `name: "${tool}"`.length);
  const next = after.indexOf('name: "');
  const seg = next >= 0 ? after.slice(0, next) : after;
  const m = /phase:\s*"(local_data|external_data|research)"/.exec(seg);
  return m ? m[1] : null;
}

// ---------- 源码形状钉：工具注册表 ----------

test("内置工具无一漏标 phase（漏标就无法显式发 phase_key，只会退回猜）", () => {
  const names = (TOOLS_BLOCK.match(/name:\s*"/g) ?? []).length;
  const phases = (TOOLS_BLOCK.match(/phase:\s*"/g) ?? []).length;
  assert.ok(names >= 17, `内置工具数量异常：${names}`);
  assert.equal(names, phases, `每个内置工具都要标 phase（name ${names} 个，phase ${phases} 个）`);
});

test("phaseOfTool 按工具真实语义返回阶段（单一映射出处）", () => {
  // 行情/盘口/资金/K线/情绪/板块/自选 → local_data（获取行情与市场数据）
  for (const n of ["market_sentiment", "sector_rank", "stock_snapshot", "stock_depth", "stock_trades", "stock_kline_summary", "stock_fund_flow", "tdx_market_overview", "tdx_quotes", "tdx_kline", "watchlist_overview"]) {
    assert.equal(declaredPhase(n), "local_data", `${n} 应归 local_data`);
  }
  // 新闻/公告 → external_data（核查新闻与公开信息）
  for (const n of ["market_news", "stock_news"]) {
    assert.equal(declaredPhase(n), "external_data", `${n} 应归 external_data`);
  }
  // 因子筛选/回测/历史概率/候选池 → research（综合分析）
  for (const n of ["factor_screener", "candidate_pool", "historical_probability", "run_backtest"]) {
    assert.equal(declaredPhase(n), "research", `${n} 应归 research`);
  }
});

test("phaseOfTool 导出且未登记工具回 null（不臆造阶段）", () => {
  assert.match(chatTools, /export function phaseOfTool\(name: string\): PhaseKey \| null/);
  assert.match(chatTools, /return findTool\(name\)\?\.phase \?\? null/);
});

// ---------- 源码形状钉：两个 step 生产方都发 phase_key ----------

test("后端路由（模型自取）发 step 时带 phase_key，且来自 phaseOfTool", () => {
  assert.match(route, /phaseOfTool/, "route 要引 phaseOfTool");
  assert.match(route, /const phaseKey = phaseOfTool\(c\.name\)/, "按真实工具名取阶段");
  const hits = (route.match(/phase_key: phaseKey/g) ?? []).length;
  assert.ok(hits >= 3, `running/终态/非流式 steps 三处都要带 phase_key（实数 ${hits}）`);
});

test("自动调度（系统预取）发 step 时也带 phase_key，来自 phaseOfTool", () => {
  assert.match(dispatchCore, /phaseFor\?\.\(call\)/, "dispatch-core 接受 phaseFor 注入");
  assert.match(dispatchCore, /phase_key: phaseKey/, "预取步骤写 phase_key");
  const hits = (sceneDispatch.match(/phaseFor: \(call\) => phaseOfTool\(call\.tool\)/g) ?? []).length;
  assert.ok(hits >= 2, `首轮与补充轮都要注入 phaseFor（实数 ${hits}）`);
});

test("合成步骤（完整性校验/新鲜度/结论卡）按真实归属标阶段，不硬塞分析", () => {
  // 完整性校验、新鲜度核对 → local_data
  assert.match(sceneDispatch, /label: "校验本轮取数完整性（必读读数逐项对账）"[\s\S]{0,220}phase_key: "local_data"/);
  assert.match(sceneDispatch, /label: "比对真实交易日历（000001\.SH）核对日K新鲜度"[\s\S]{0,220}phase_key: "local_data"/);
  // v3 引擎实算结论 → research（这一条就是"综合分析"这一步真正做的事）
  assert.match(sceneDispatch, /现场用 v3 引擎算结论卡[\s\S]{0,260}phase_key: "research"/);
});

// ---------- 纯核：deriveAgentPhases 优先 phase_key ----------

test("deriveAgentPhases 优先用 phase_key（与研究判定一致，不被 label 带偏）", () => {
  // label 看着像行情，但 phase_key 明确是 external_data → 归 external_data，local_data 无
  const steps: StepInfo[] = [
    { step: 1, label: "取行情快照", status: "ok", tool: "quote", phase_key: "external_data" },
    { step: 2, label: "跑筛选器", status: "ok", tool: "factor_screener", phase_key: "research" },
  ];
  const r = deriveAgentPhases(steps, null, msg());
  const status = Object.fromEntries(r.map((p) => [p.key, p.status]));
  assert.equal(status.external_data, "done", "phase_key=external_data 应点亮 external_data");
  assert.equal(status.local_data, "pending", "没有归到 local_data 的步骤");
  assert.equal(status.research, "done", "factor_screener 归 research");
});

test("deriveAgentPhases 无 phase_key 时回落 classifyStep（旧存档/旧客户端不变）", () => {
  const steps: StepInfo[] = [
    { step: 1, label: "取行情", status: "ok", tool: "quote" },
    { step: 2, label: "取新闻", status: "ok", tool: "news" },
  ];
  const r = deriveAgentPhases(steps, null, msg());
  const status = Object.fromEntries(r.map((p) => [p.key, p.status]));
  assert.equal(status.local_data, "done");
  assert.equal(status.external_data, "done");
  assert.equal(status.research, "pending");
});

test("deriveAgentPhases 与 groupStepsByPhase 同口径：phase_key 优先于 classifyStep", () => {
  // 冲突步骤：label="取新闻"（语义→external_data），phase_key="local_data"
  const steps: StepInfo[] = [
    { step: 1, label: "取新闻", status: "ok", tool: "news", phase_key: "local_data" },
  ];
  assert.equal(classifyStep(steps[0]), "external_data", "语义映射本身应指向 external_data");
  const r = deriveAgentPhases(steps, null, msg());
  const status = Object.fromEntries(r.map((p) => [p.key, p.status]));
  assert.equal(status.local_data, "done", "phase_key 优先 → local_data");
  assert.equal(status.external_data, "pending", "不按语义映射归到 external_data");
});
