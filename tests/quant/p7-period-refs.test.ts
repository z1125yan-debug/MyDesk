// P7-② 概率样本区间进台账 refs 的回归测试（纯内核 + 纯函数，不联网、不写库、不调模型）。
//
// 这一小步要修的是一条真实缺口（worklog「P6 第八阶段 第五部分」）：同一台机器、同一交易日，
// risk 工具的相似环境统计在 5 分钟内从「样本 113 / 1日胜率 46.9%」变成「样本 225 / 52.9%」，
// 而 agent_tool_call 的 26 列里没有 payload、台账 refs 只有 trade_date/sample/horizon，
// 事后无法从库里重建那一次用的是哪一段窗口。评审确认结论 §四 授权把 period 提进 refs。
//
// 三条边界钉死：
// 1) 提的是**第二层标量**（period_start/period_end）。引擎自己返回的 period 是 {start,end} 对象，
//    在 extractRefs 的 depth>2 位置上，原样传下去永远抽不出来——这是 P6-D 那条 horizon 缺口的同一个坑。
// 2) §十九 的必需三项**没有扩大**：period 缺失不判违规，答案引用概率照旧只查 trade_date/sample/horizon。
//    否则本次改动会立刻把 P6-D 已封版的历史台账行全部判成不成立。
// 3) 区间只能来自引擎真实返回：没有 period 时 payload 里是 null，refs 里不会出现 period 键，
//    摘要里明写「样本区间未给出」，不拿基准日或今天冒充窗口起点。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  admitCall, extractRefs, recordCall, startRun, verifyAgentAnswer, type AgentState,
} from "../../src/lib/quant/screener/agent-loop-core.ts";
import { findTool } from "../../src/lib/quant/screener/agent-tools-core.ts";
import { similarReturnForward } from "../../src/lib/quant/screener/similar-env.ts";

const T0 = 1_000_000;
const NOW = "2026-09-20 10:00:00";

function fresh(): AgentState {
  return startRun({ run_id: "r1", question: "上证相似环境的 1 日胜率是多少？", started_at: NOW, started_ms: T0 }).state;
}

/** 与 agent-tools.ts riskObs 现行输出同形（第二层标量 + 原对象并存） */
const riskPayload = (withPeriod = true) => ({
  trade_date: "2026-09-20", level: "正常", triggers: [], live: true, advancers: 4234, decliners: 1152,
  similar_env: {
    sample: 225, sample_ok: true, horizon: 1,
    period: withPeriod ? { start: "2024-08-06", end: "2026-08-20" } : null,
    period_start: withPeriod ? "2024-08-06" : null, period_end: withPeriod ? "2026-08-20" : null,
    horizons: [{ horizon: 1, win_rate: 52.888, sample: 225 }],
  },
});

test("P7-② period_start/period_end 进了 REF_KEYS：一次 risk 调用的台账行现在带得起样本区间", () => {
  const refs = extractRefs(riskPayload());
  assert.ok(refs.includes("period_start=2024-08-06"), refs.join("、"));
  assert.ok(refs.includes("period_end=2026-08-20"), refs.join("、"));
  // 原有三项一个都不能被新键挤掉（refs 上限 12，risk 载荷远不到顶，但顺序假设要显式否定）
  for (const k of ["trade_date=2026-09-20", "sample=225", "horizon=1"]) assert.ok(refs.includes(k), `${k} 被挤掉了：${refs.join("、")}`);
  assert.equal(new Set(refs).size, refs.length, "refs 不允许出现重复项");
});

test("P7-② 为什么必须提成标量：原样的 period 对象抽不到，这条断言就是本次改动的存在理由", () => {
  const onlyObject = { trade_date: "2026-09-20", similar_env: { sample: 225, horizon: 1, period: { start: "2024-08-06", end: "2026-08-20" } } };
  const refs = extractRefs(onlyObject);
  assert.deepEqual(refs.sort(), ["horizon=1", "sample=225", "trade_date=2026-09-20"],
    `period 是第三层对象，extractRefs 到 depth>2 就返回 ⇒ 不改服务层的话窗口永远进不了台账：${refs.join("、")}`);
  assert.ok(!refs.some((r) => r.startsWith("period")), "不该出现任何 period 项：出现即说明抽取层被改过，本文件的另一条断言要跟着复核");
});

test("P7-② 必需三项没有扩大：没有 period 的历史台账行仍然过关（P6-D 已封版记录不受破坏）", () => {
  const legacy = fresh();
  const a = admitCall(legacy, "risk", {}, T0);
  const { state } = recordCall(legacy, {
    tool: "risk", input: {}, output_status: "ok", kind: "value", call_key: a.call_key,
    source: "sentiment 引擎风险分项 + 上证相似日统计（similar-env）", data_status: "DERIVED", timestamp: NOW,
    // P6-D 当时真实落库的那一行形态：没有 period
    summary: "风险等级「正常」；涨跌家数 4234/1152；炸板率 27.8%；上证相似环境后续统计：样本 113 个，1日胜率 46.9%（HISTORICAL，不是今天的预测）",
    payload: { trade_date: "2026-09-20", level: "正常", similar_env: { sample: 113, horizon: 1 } },
  });
  assert.deepEqual(state.evidence[0].refs, ["trade_date=2026-09-20", "sample=113", "horizon=1"], "旧形态载荷的 refs 一字不变");
  const id = state.evidence[0].line.id;
  const check = verifyAgentAnswer({ answer: `相似环境 1 日胜率 46.9%（历史样本 113 个，不是今天的预测）[${id}]`, cites: [id], gaps: [], state });
  assert.deepEqual(check.probability_gaps, [], check.probability_gaps.join(" / "));
  assert.equal(check.status, "ACCEPTED", "区间没进 refs 不构成违规：period 是补充口径，不是 §十九 的必需项");
});

test("P7-② 带区间的行同样过关，且缺 horizon 时仍然被抓（多收两项没有放松判据）", () => {
  const s0 = fresh();
  const a = admitCall(s0, "risk", {}, T0);
  const { state } = recordCall(s0, {
    tool: "risk", input: {}, output_status: "ok", kind: "value", call_key: a.call_key,
    source: "sentiment 引擎风险分项 + 上证相似日统计（similar-env）", data_status: "DERIVED", timestamp: NOW,
    summary: "风险等级「正常」；上证相似环境后续统计：样本 225 个，1日胜率 52.9%（HISTORICAL，不是今天的预测），样本区间 2024-08-06→2026-08-20",
    payload: riskPayload(),
  });
  const id = state.evidence[0].line.id;
  const ok = verifyAgentAnswer({ answer: `相似环境 1 日胜率 52.9%（历史样本 225 个，区间 2024-08-06→2026-08-20，不是今天的预测）[${id}]`, cites: [id], gaps: [], state });
  assert.deepEqual(ok.probability_gaps, []);
  assert.equal(ok.status, "ACCEPTED");
  assert.ok(ok.lineage[0].refs.includes("period_start=2024-08-06"), "血缘里要能重建窗口，这才这一步的目的");

  // 把 horizon 拿掉：判据必须照样指向 horizon 缺口，而不是因为有 period 就放过
  const noHorizon: AgentState = {
    ...state,
    evidence: [{ ...state.evidence[0], refs: ["trade_date=2026-09-20", "sample=225", "period_start=2024-08-06", "period_end=2026-08-20"] }],
  };
  const bad = verifyAgentAnswer({ answer: `相似环境 1 日胜率 52.9%（[${id}]）`, cites: [id], gaps: [], state: noHorizon });
  assert.match(bad.probability_gaps.join(" / "), /horizon/, bad.probability_gaps.join(" / "));
});

test("P7-② period 为 null 时不进 refs：没有窗口就如实没有，不拿基准日或今天凑", () => {
  const refs = extractRefs(riskPayload(false));
  assert.ok(!refs.some((r) => r.startsWith("period")), `period_start=null 不该产生引用项：${refs.join("、")}`);
  assert.ok(refs.includes("sample=225"), "其余口径不受影响");
});

test("P7-② 区间本身是引擎真实算出来的匹配日范围，且注册表把「引用概率要带前三项」写在了输出契约里", () => {
  // 纯函数用合成序列验证「period 的含义」，不是行情事实：这段只证明字段语义，数据本身是测试夹具
  const bars = Array.from({ length: 90 }, (_, i) => ({ date: `2025-01-${String(i + 1).padStart(2, "0")}`, c: 100 + Math.sin(i / 3) * 2 }));
  const stats = similarReturnForward(bars, 0.8);
  const window = stats.period;
  if (window) {
    assert.match(window.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(window.start <= window.end, "区间起点不可能晚于终点");
    assert.ok(bars.some((b) => b.date === window.start) && bars.some((b) => b.date === window.end),
      "period 必须是输入序列里真实存在的日期，不能是拼出来的字符串");
  } else {
    assert.equal(stats.sample_size, 0, "没有匹配日时 period 才是 null：有样本却没区间要当成缺陷复核");
  }
  const riskOut = findTool("risk")?.outputSchema ?? "";
  assert.match(riskOut, /period_start\/period_end/, "risk 的输出契约要告诉模型区间现在可读");
  assert.match(riskOut, /trade_date\/sample\/horizon/, "前三项必需口径不能因为新增两项被写丢");
  assert.match(findTool("snapshot_probability")?.outputSchema ?? "", /引用概率必须带这三项口径/, "留档概率的契约保持 P6-D 原样");
});
