// P8-④ 完整 Agent Loop 闭环的纯内核：取数回来之后、发给模型之前，先回答两个问题——
// 「本轮必读的读数齐不齐」「缺的那几项值不值得再补一轮」。不足就把缺项原样重排成一轮补充调用，
// 补完仍旧缺的，如实留在「本轮未取到」清单里（不拿缺口当齐备下结论）。
//
// 链路形状（任务书八-2）：提问 -> 意图识别（intent-core）-> 自动调用工具（planDispatch+dispatch-core）
// -> 校验数据完整性（本层）-> 不足则补充调用（本层出计划，scene-dispatch 执行）-> 综合分析 -> 生成结论（模型）。
// 之前缺的就是中间「校验 + 补充」这一环：预取失败一项就直接带着洞进模型，那是单轮直调，不是闭环。
//
// 三条口径：
//  1) 补充只重跑「required 且没取到」的那几项，参数原样、理由写明是第几轮补的——
//     整批重跑等于把同一份行情接口再打一遍，慢且不诚实；
//  2) 上限一轮（AGENT_LOOP_MAX_ROUNDS=2 含首轮）：东财 502 风暴期间补三轮也只是三轮失败，
//     对话等不起，到点就带着留痕进综合环节；
//  3) rows 与 missing 的配对靠「计划顺序 + 非 ok 行必产生一条 gap」这一 dispatch-core 不变量，
//     对不上时宁可不补（保持原清单），也不猜哪条失败对应哪个洞。
import type { DispatchCall } from "./intent-core.ts";
import type { DispatchRow } from "./dispatch-core.ts";

/** 一轮问答里取数环节最多跑几轮（首轮 + 1 次补充）。改大要同时想清楚 502 风暴下的等待成本 */
export const AGENT_LOOP_MAX_ROUNDS = 2;

export interface RequiredGap {
  /** 缺口对应的首轮调用在 calls 里的下标（补充轮拿同一份 args 原样重跑） */
  idx: number;
  tool: string;
  why: string;
  /** 该缺口在 missing 数组里的下标（合并时精确摘除，不按文案内容猜同） */
  missIdx: number;
}

/**
 * 找出「必读却没取到」的洞。
 * rows 与 calls 按计划顺序一一对应（dispatch-core 保证），非 ok 行按计划顺序各产一条 missing——
 * 用同一个游标配对；行数与 gap 数对不上时（编排层被改坏的信号）返回空集，让原清单原样出去。
 */
export function findRequiredGaps(opts: {
  calls: DispatchCall[];
  rows: DispatchRow[];
  missing: { tool: string; why: string }[];
  required: Set<string>;
}): RequiredGap[] {
  const { calls, rows, missing, required } = opts;
  if (!required.size || !rows.length) return [];
  const nonOkCount = rows.filter((r) => !r.ok).length;
  if (nonOkCount !== missing.length) return []; // 对不上账：不猜，保持原样
  const gaps: RequiredGap[] = [];
  let m = 0;
  rows.forEach((r, i) => {
    if (r.ok) return;
    const miss = missing[m];
    m++;
    if (i >= calls.length || !required.has(r.tool)) return;
    gaps.push({ idx: i, tool: r.tool, why: miss?.why ?? "上一轮未取到（原因未留痕）", missIdx: m - 1 });
  });
  return gaps;
}

/** 补充轮计划：缺项原参数重跑，理由带上轮次与上一轮的失败话术（用户看时间线能看懂为什么又多了一步） */
export function planSupplementRound(gaps: RequiredGap[], calls: DispatchCall[], round = 2): DispatchCall[] {
  const seen = new Set<number>();
  const out: DispatchCall[] = [];
  for (const g of gaps ?? []) {
    if (seen.has(g.idx)) continue;
    seen.add(g.idx);
    const c = calls[g.idx];
    if (!c) continue;
    out.push({ tool: c.tool, args: { ...c.args }, reason: `补充调用（第 ${round} 轮）：上一轮${g.why}` });
  }
  return out;
}

/**
 * 把补充轮的结果并回首轮清单：
 *  - 补到的替换原缺口行（注入块里就有这份真数据了）；
 *  - 仍旧缺的换成补充轮给的原因，并标明「补充后仍缺」——两轮的话术都留底，不粉饰成一次失败；
 *  - 与缺项无关的行/清单原样保留。
 */
export function mergeSupplement(
  first: { rows: DispatchRow[]; missing: { tool: string; why: string }[] },
  gaps: RequiredGap[],
  second: { rows: DispatchRow[]; missing: { tool: string; why: string }[] },
): { rows: DispatchRow[]; missing: { tool: string; why: string }[] } {
  const rows = [...first.rows];
  const drop = new Set(gaps.map((g) => g.missIdx));
  const missing = first.missing.filter((_, i) => !drop.has(i));
  // 补充轮的 why 与 rows 按 dispatch-core 的同一不变量对齐（非 ok 行按计划顺序各产一条 gap），
  // 不能按工具名 find：同批重试两只票的 stock_snapshot 时，名字会把第一只的失败原因安到第二只头上。
  const secondWhys: (string | null)[] = [];
  {
    let mi = 0;
    for (const r of second.rows) secondWhys.push(r.ok ? null : (second.missing[mi++]?.why ?? "补充调用仍未取到"));
  }
  gaps.forEach((g, i) => {
    const r2 = second.rows[i];
    if (!r2) return;
    rows[g.idx] = r2;
    if (!r2.ok) {
      const why2 = secondWhys[i] ?? "补充调用仍未取到";
      missing.push({ tool: g.tool, why: `补充后仍缺：${why2}（首轮：${g.why}）` });
    }
  });
  return { rows, missing };
}

/** 完整性校验步骤的说法（ok/missing 两态都只陈述事实，不承诺「下一轮就能补上」） */
export function completenessVerdict(gaps: RequiredGap[], requiredCount: number): { status: "ok" | "missing"; detail: string } {
  if (!gaps.length) return { status: "ok", detail: `${requiredCount} 项必读读数齐（首轮）` };
  return {
    status: "missing",
    detail: `必读 ${requiredCount} 项里缺 ${gaps.length} 项：${gaps.map((g) => `${g.tool}（${g.why}）`).join("；")}，做一轮补充调用`,
  };
}

/** 补充轮之后仍缺的清单话术（进 skipped，徽章与「本轮没做成什么」都要能看到） */
export function stillMissingNote(gaps: RequiredGap[], second: { rows: DispatchRow[] }): string | null {
  const still = gaps.filter((_, i) => !second.rows[i] || !second.rows[i].ok).map((g) => g.tool);
  return still.length ? `补充调用后仍缺 ${still.length} 项必读读数：${[...new Set(still)].join("、")}（已如实列入本轮未取到）` : null;
}
