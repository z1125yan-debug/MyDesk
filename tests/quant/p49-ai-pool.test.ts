// 2026-09-26 稳智「量化因子选股 → AI优选 → 前往 AI 对话」对齐测试。
//
// 逆向依据（源码实证 + 只读实测，报告 `scrape-aiwuchuan/AI优选-候选池流程.md`）：
//   · 选股页 `StockScreener-*.js`：按钮「稳智AI优选」→ 弹窗「交给稳智AI优选」→ `at()`
//     → `POST /api/candidate-pools`（冻结 ≤300 只）→ `router.push({name:"aiMatrix",query:{candidate_pool,prompt,trading_horizon}})`
//   · AI 页 `AiMatrixHome-*.js`：onMounted 读 query → 新建会话 + `B.value=prompt`（**只预填、不 submit**）
//
// 本地映射：候选池落 `store.frozenPools`（source="AI优选"），交棒走 `askAiWithPool`（跳 copilot + 预填 + 落周期）。
// 纪律：不猜文案、不造参数——每条断言都对着稳智原文或本地唯一实现点。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const wb = read("src/components/desk/pages/ScreenerWorkbench.tsx");
const asst = read("src/components/desk/pages/AssistantPage.tsx");
const store = read("src/lib/desk/store.ts");
const nav = read("src/lib/desk/nav-core.ts");

test("AI优选弹窗：4 参文案逐字对齐稳智（分析周期/风险偏好/期望数量/补充要求）", () => {
  for (const s of [
    "交给稳智AI优选", "创建候选池并前往稳智AI",
    "分析周期", "风险偏好", "期望最终数量（Agent可少选或不选）", "补充要求（可选）",
  ]) {
    assert.ok(wb.includes(s), `缺稳智原文：${s}`);
  }
  // 分析周期三档：稳智英文 value + 中文文案逐字照搬
  for (const s of ["超短线（1-3个交易日）", "短中期（1-3周）", "中期波段（1-8周）"]) {
    assert.ok(wb.includes(s), `缺周期档：${s}`);
  }
  for (const s of ['"ultra_short"', '"short_mid_term"', '"mid_term"']) {
    assert.ok(wb.includes(s), `缺周期 value：${s}`);
  }
  // 风险偏好 value 就是中文串本身（稳智 radio-button 的口径）；期望数量 3/5/10
  assert.match(wb, /const POOL_RISKS = \["稳健", "均衡", "激进"\] as const/, "风险偏好三档且 value=中文串");
  assert.match(wb, /const POOL_COUNTS = \[3, 5, 10\] as const/, "期望数量 3/5/10");
  // 底部说明逐字
  assert.ok(
    wb.includes("将冻结当前交易日与筛选条件的候选池；最多保存页面排序前300只。页面顺序不是推荐，最终维度、取数和入选由Agent自主决定。"),
    "底部说明要逐字对齐稳智",
  );
});

test("AI优选建池：冻结前 300 只 + 拼稳智同款问句 + 交棒给对话页（选股页不再自己发 AI 请求）", () => {
  assert.match(wb, /const stored = list\.slice\(0, 300\)/, "冻结上限 300（对齐稳智 stored_count）");
  // 真实数据量对齐：列表页 20/页，建池必须单独按 300 拉一次（否则只冻到 20 条）且不写回页面 state
  assert.match(wb, /const buildBody = useCallback\(\(pg: number, limit = 20\)/, "buildBody 支持 limit（列表 20 / 建池 300）");
  assert.match(wb, /await ensureRows\(300, false\)/, "建池一次拿「页面排序前 300」且 commit=false（不撑爆列表页）");
  assert.match(wb, /source: "AI优选"/, "冻结池标 source=AI优选（「AI优选记录」据此筛）");
  assert.match(wb, /prompt,/, "问句随池一起留档（「再次前往AI」原样重发）");
  // 稳智 5 行模板（第 4 行是可选补充要求，本地用 filter(Boolean) 兜）
  for (const line of [
    "请从量化候选池中自主研究并优选，最多选出",
    "我的风险偏好是",
    "请自主决定评价维度、权重、需要补充的数据与工具调用，不要把页面原始排序当作推荐结果。",
    "最终给出入选理由、入场条件、仓位节奏、失效条件和主要风险。",
  ]) {
    assert.ok(wb.includes(line), `问句模板缺：${line}`);
  }
  assert.match(
    wb,
    /askAiWithPool\(\{ poolId: pool\.id, label: pool\.label!, prompt, horizon: hz\.local \}\)/,
    "交棒走 store.askAiWithPool（跳 copilot + 预填）",
  );
  // 发送只发生在对话页：选股页不该再直连 AI 端点（稳智也是「建池 → 跳对话」）
  assert.ok(!/\/api\/ai\/proxy/.test(wb), "选股页不再自己发 AI 请求");
});

test("AI优选交棒：对话页预填问句 + 挂候选池徽章，且**不自动发送**", () => {
  assert.match(asst, /takeAiPoolHandoff\(\)/, "对话页取走 AI优选 交接");
  assert.match(asst, /const aiPoolHandoff = useDesk\(\(s\) => s\.aiPoolHandoff\)/, "订阅交接字段本身（已在对话页时又来一棒也生效）");
  assert.match(asst, /if \(!aiPoolHandoff\) return;/, "无交接不预填");
  assert.match(asst, /setInput\(h\.prompt\)/, "把问句预填进输入框");
  assert.match(asst, /setPoolBadge\(\{ label: h\.label \}\)/, "挂候选池徽章（对齐 candidate_pool_label）");
  // 关键口径：AI优选 交接不许顺手 send —— 立即发是 pendingAsk 的语义，两者不能混
  const from = asst.indexOf("const h = takeAiPoolHandoff()");
  const to = asst.indexOf("}, [aiPoolHandoff, takeAiPoolHandoff]);");
  assert.ok(from > 0 && to > from, "AI优选 消费块要能被定位");
  assert.ok(!/send\(/.test(asst.slice(from, to)), "AI优选 交接不得自动发送（稳智只 B.value=prompt）");
});

test("store：AiPoolHandoff 一次性交接 + 顺带落周期 + 不进存档", () => {
  assert.match(store, /aiPoolHandoff: AiPoolHandoff \| null;/, "状态字段存在");
  assert.match(store, /set\(\{ aiPoolHandoff: h, assistantHorizon: h\.horizon, page: "copilot" \}\)/,
    "交棒同时写周期（对齐稳智 payload 的 trading_horizon）并跳 copilot");
  assert.match(store, /if \(h\) set\(\{ aiPoolHandoff: null \}\)/, "取一次即清（刷新不重填）");
  assert.match(store, /if \(!h\?\.prompt\.trim\(\)\) return;/, "空问句不交接");
  const partialize = store.slice(store.indexOf("partialize: (s) => ({"));
  assert.ok(!/aiPoolHandoff/.test(partialize), "aiPoolHandoff 不得进 partialize（一次性交接，同 pendingAsk）");
});

test("AI优选能落得到对话页：copilot 必须直达（不许再被收口到 llmportal）", () => {
  assert.ok(!/copilot: "llmportal"/.test(nav), "copilot→llmportal 重定向必须已删除（否则交棒被劫持到 LLM分析）");
  assert.match(nav, /HIDDEN_PAGES[\s\S]*?\{ key: "copilot", group: "ai" \}/, "copilot 登记在 HIDDEN_PAGES 的 ai 组（高亮 + 登记一处）");
});
