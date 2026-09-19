// P6-D 第三阶段：Agent 循环服务层（agent-run.ts）测试。
//
// 两层结构与 P4/P5 同一套路：
// A) 纯映射（内存里跑）：run_id 口径、日志 ↔ 库行 的双向无损、从调用行重建状态。
// B) 机制验收（真实库副本 + 注入假执行器）：建账幂等 → 走一步 → 同参数缓存 → 预算撞墙 →
//    自然键幂等 → 收尾复校验（REJECTED 不覆盖已成立结论）→ 状态重建与库里计数一致。
//
// 关于假执行器（重要，REAL_DATA_ONLY）：
// 注入的 fakeTool **不发任何网络请求、不读任何行情**，它只按测试需要造一个 ToolObservation，
// 用来验证「准入 / 记账 / 落库 / 重建」这套机制。因此它写进副本库的每一行 summary 都带 MK 前缀
// （〔机制测试行·假执行器产出，不是行情〕）。真实库文件在测试前后必须字节数与 mtime 完全不变。
//
// 运行：node --test --experimental-strip-types tests/quant/p6-d-agent-run.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentRunView, entryToRow, finalizeAgentRun, listAgentRuns, loadAgentRun, replayAgentState, rowToEntry,
  runAgentStep, runIdError, startAgentRun, type AgentRunDb, type RunToolFn,
} from "../../src/lib/quant/screener/agent-run.ts";
import { DEFAULT_AGENT_BUDGET } from "../../src/lib/quant/screener/agent-loop-core.ts";
import { findTool, okObs, emptyObs, failedObs, notCoveredObs } from "../../src/lib/quant/screener/agent-tools-core.ts";
import { DATA_STATUSES } from "../../src/lib/quant/screener/datastatus-core.ts";

const DB_FILE = path.join(process.cwd(), "prisma", "db", "custom.db");
const MK = "〔机制测试行·假执行器产出，不是行情〕";
const AT = "2026-09-19 21:30:00";
const T0 = 1_700_000_000_000;

const clockAt = (ms: number) => ({ now: AT, now_ms: ms });

// ---------- A) 纯映射：不连库也能判的三件事 ----------

test("run_id 口径：空 / 超长 / 带路径或空格都拒，合法串放行", () => {
  assert.match(String(runIdError("")), /缺少 run_id/);
  assert.match(String(runIdError("x".repeat(65))), /过长/);
  for (const bad of ["a/b", "../etc", "has space", "带中文", "a+b"]) {
    assert.match(String(runIdError(bad)), /只能含字母数字/, `${bad} 不该被接受`);
  }
  assert.equal(runIdError("run-2026_09_19-a1"), null);
  assert.equal(runIdError("  padded  "), null, "两端空白应被 trim 后接受");
});

test("日志 ↔ 库行双向映射：§十八 要求的字段一个都不能在落库时丢掉", () => {
  const e = {
    run_id: "r1", step: 3, tool: "radar", input: { date: "2026-09-19", extra: [1, 2] },
    output_status: "ok" as const, kind: "value" as const, latency_ms: 42,
    source: "radar_finding 表", as_of: "2026-09-19", data_status: "REAL" as const,
    error: null, fallback_of: "stock_quote", attempt: 2, call_key: "radar|{}", cached_from: null,
    evidence_id: "F01", thought: "先看库里有什么", degraded_from: "gateway", timestamp: AT,
  };
  const row = entryToRow("r1", e, { capability: "radar.findings", executor: "db.radar", summary: "一行摘要", notes: ["n1"], refs: ["finding_id=7"] });
  const back = rowToEntry(row);
  assert.deepEqual(back, e, "写库再读回必须得到同一条日志（少一个字段就是事后无法重建）");
  assert.equal(row.step, 3);
  assert.equal(row.capability, "radar.findings");
  assert.deepEqual(JSON.parse(row.refsJson), ["finding_id=7"]);

  // 库里出现未知状态（老版本行 / 手工改库）：按 failed 处理，绝不因映射不到就当作 ok
  assert.equal(rowToEntry({ ...row, outputStatus: "weird" }).output_status, "failed");
  assert.equal(rowToEntry({ ...row, latencyMs: null }).latency_ms, null, "未执行的步没有耗时，不能记成 0");
  assert.equal(rowToEntry({ ...row, dataStatus: "" }).data_status, null, "空分层保持空：由重建层判定它进不了台账");
});

test("状态重建：step/调用数/重试/缓存/连续无进展全部从调用行推出，不认识的分层进缺口", () => {
  const rows = [
    entryToRow("r2", { step: 1, tool: "radar", input: {}, output_status: "ok", kind: "value", data_status: "REAL", source: "s", as_of: "2026-09-19", attempt: 2, call_key: "k1", evidence_id: "F01", timestamp: AT } as never, { summary: `${MK}雷达 3 条`, refs: ["finding_id=1"] }),
    entryToRow("r2", { step: 2, tool: "events", input: {}, output_status: "empty", kind: "no_data", data_status: "MISSING", attempt: 1, call_key: "k2", evidence_id: null, timestamp: AT } as never),
    entryToRow("r2", { step: 3, tool: "radar", input: {}, output_status: "cached", attempt: 1, call_key: "k1", evidence_id: "F01", cached_from: "F01", timestamp: AT } as never),
    entryToRow("r2", { step: 4, tool: "sentiment", input: {}, output_status: "ok", kind: "value", data_status: "说不上来的分层", attempt: 1, call_key: "k4", evidence_id: "X01", timestamp: AT } as never),
  ];
  const { state, skipped } = replayAgentState({
    runId: "r2", question: "q", budgetJson: JSON.stringify(DEFAULT_AGENT_BUDGET),
    startedAt: AT, startedMs: T0, stop: null, rows,
  });
  assert.equal(state.step, 4, "步数 = 调用行数");
  assert.equal(state.tool_calls, 3, "cached 不算一次新调用（§三十二 没打上游）");
  assert.equal(state.attempts_by_tool.radar, 2, "行里存的 attempt 是权威值：重建取行里的最大值，而不是按行数重新数一遍");
  assert.equal(state.cache.k1, "F01", "同参数缓存表要能从行里恢复，否则重启后必然重复打上游");
  assert.equal(state.consecutive_no_progress, 0, "最后一行是 ok ⇒ 连续无进展清零（内核按「这次有没有新读数」判，不看总次数）");
  assert.equal(replayAgentState({
    runId: "r2", question: "q", budgetJson: "{}", startedAt: AT, startedMs: T0, stop: null, rows: rows.slice(0, 3),
  }).state.consecutive_no_progress, 2, "empty 之后再来一次 cached（没有新读数）应累计到 2：这是「停摆」判定的依据");
  assert.equal(state.evidence.length, 1);
  assert.equal(state.evidence[0].line.text, `${MK}雷达 3 条`);
  assert.deepEqual(state.evidence[0].refs, ["finding_id=1"]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /不在 DATA_STATUSES 内/, "不认识的行要能说清为什么不算证据");
  assert.equal(state.evidence.some((x) => x.line.id === "X01"), false, "未知分层不得进台账（不能拿它冒充 FACTS）");
  // 乱序输入也要按 step 升序重放（库里有 orderBy，但本层不依赖调用方排序）
  const rev = replayAgentState({
    runId: "r2", question: "q", budgetJson: "{}", startedAt: AT, startedMs: T0, stop: null, rows: [...rows].reverse(),
  });
  assert.deepEqual(rev.state.log.map((l) => l.step), [1, 2, 3, 4]);
});

// ---------- B) 机制验收：真实库副本 + 注入假执行器 ----------

function statOf(file: string): { size: number; mtimeMs: number } {
  const st = fs.statSync(file);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

/** 只回测试指定观测的执行器：不发请求、不读行情，产出全部带 MK 前缀 */
function makeFakeTool(makeObs: (name: string, n: number) => ReturnType<typeof okObs>) {
  const calls: { count: number; names: string[] } = { count: 0, names: [] };
  const fn: RunToolFn = async (name, rawParams) => {
    calls.count += 1;
    calls.names.push(String(name));
    const t = findTool(String(name));
    return {
      tool: String(name), title: t?.title ?? "", capability: t?.capability ?? "", executor: t?.executor ?? null,
      params: (rawParams ?? {}) as Record<string, string | number | boolean | string[]>,
      param_errors: [], obs: makeObs(String(name), calls.count), latency_ms: 7, timeout_ms: t?.timeout_ms ?? 8000,
    };
  };
  return { fn, calls };
}

const REAL_VALUE = () => okObs({
  summary: `${MK}机制读数：当日 3 条雷达`, source: "fake://机制测试", as_of: "2026-09-19",
  data_status: "REAL", payload: { findings: [{ finding_id: "9001" }] },
});

test("机制验收：副本上跑完一整轮（建账→两步→缓存→收尾），库里计数与内存状态一致", async () => {
  assert.ok(fs.existsSync(DB_FILE), "运行时库不存在（prisma/db/custom.db）：本用例依赖真实表结构，不伪造");
  const before = statOf(DB_FILE);
  const tmp = path.join(os.tmpdir(), `p6d-agent-run-${Date.now()}.db`);
  fs.copyFileSync(DB_FILE, tmp);
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasourceUrl: `file:${tmp.replace(/\\/g, "/")}` }) as unknown as AgentRunDb & {
    $disconnect(): Promise<void>;
    $queryRawUnsafe(sql: string, ...p: unknown[]): Promise<Record<string, unknown>[]>;
  };
  const rid = "mech-run-1";
  try {
    const tables = await db.$queryRawUnsafe("SELECT name AS n FROM sqlite_master WHERE type='table'");
    const has = new Set(tables.map((r) => String(r.n)));
    assert.ok(has.has("agent_run") && has.has("agent_tool_call"), "两张表未创建（先跑 prisma db push）");

    // 1) 建账 + 幂等重提
    const st = await startAgentRun({ run_id: rid, question: "机制测试：今天库里有什么可读的？" }, db, clockAt(T0));
    assert.equal(st.ok, true);
    assert.equal(st.resumed, false);
    assert.equal(st.http, 200);
    assert.equal(st.status, "running");
    assert.match(st.prompt.turn, /输出协议/, "开跑就发下一轮提示词：客户端不必自己拼");
    const again = await startAgentRun({ run_id: rid, question: "换了一个问题" }, db, clockAt(T0 + 1000));
    assert.equal(again.resumed, true, "同一个 run_id 再提交必须是「接着跑」，不是重建");
    assert.equal(again.ok, true);
    const runCount = await db.$queryRawUnsafe("SELECT COUNT(*) AS n FROM agent_run WHERE runId=?", rid);
    assert.equal(Number((runCount[0] as { n: number }).n), 1, "重提不得多出第二行 run");
    const q = await db.agentRun.findUnique({ where: { runId: rid }, select: { question: true } });
    assert.match(String(q?.question), /今天库里有什么可读的/, "已有运行的问题不能被第二次提交悄悄换掉");

    // 2) 走一步（真执行器被注入的假执行器顶掉：这里证明的是记账，不是行情）
    const fake = makeFakeTool(REAL_VALUE);
    const s1 = await runAgentStep({ run_id: rid, tool: "radar", args: {}, thought: "先看库里现成的" }, db, clockAt(T0 + 2000), fake.fn);
    assert.equal(s1.ok, true, s1.error ?? "");
    assert.equal(s1.http, 200);
    assert.equal(s1.admitted, true);
    assert.equal(s1.observation.kind, "value");
    assert.equal(s1.call.step, 1);
    assert.equal(s1.call.output_status, "ok", "走一步的响应必须用 §十八 的字段名（与库里行、时间线同形）");
    assert.equal(s1.call.evidence_id, "F01", "第一条 FACTS 台账应编到 F01");
    assert.equal(s1.evidence_lines, 1);
    assert.deepEqual(s1.call.refs, ["finding_id=9001"], "业务主键要随台账行进库（§十九）");
    assert.equal(typeof s1.call.latency_ms, "number", "真执行了一步 ⇒ 计时是数字");
    assert.equal(fake.calls.count, 1);

    // 2b) 同一条调用行在两个接口上必须同形：页面只需要一套渲染（§三十一）
    const viewAfterStep1 = await agentRunView(rid, db, clockAt(T0 + 2500));
    assert.deepEqual(Object.keys((viewAfterStep1.timeline as Record<string, unknown>[])[0]).sort(), Object.keys(s1.call).sort(),
      "POST /api/agent/tool 的 call 与 GET /api/agent/run 的 timeline 行字段名不一致：同一条记录两种形状，页面必然漏字段");

    // 3) 同参数再调一次 ⇒ 命中缓存：不打上游、不加调用数、复用同一行台账
    const s2 = await runAgentStep({ run_id: rid, tool: "radar", args: {} }, db, clockAt(T0 + 3000), fake.fn);
    assert.equal(s2.ok, true);
    assert.equal(s2.admitted, false, "缓存命中不是「执行了一次」");
    assert.equal(s2.call.output_status, "cached");
    assert.equal(s2.call.evidence_id, "F01", "复用原始那一条台账，而不是新编一行");
    assert.equal(s2.dead_end, null, "缓存命中不算碰壁：它拿到了数");
    assert.equal(fake.calls.count, 1, "第二次不得打上游（§三十二）");
    assert.match(String(s2.basis), /没有打上游/);

    // 4) 换一个工具：预算收紧到 max_tool_calls=2 ⇒ 第三次调用被挡，但照样记一条
    const tight = "mech-run-2";
    await startAgentRun({ run_id: tight, question: "机制测试：预算撞墙", budget: { max_tool_calls: 2 } }, db, clockAt(T0));
    const f2 = makeFakeTool(REAL_VALUE);
    await runAgentStep({ run_id: tight, tool: "radar", args: {} }, db, clockAt(T0 + 10), f2.fn);
    await runAgentStep({ run_id: tight, tool: "events", args: {} }, db, clockAt(T0 + 20), f2.fn);
    const s3 = await runAgentStep({ run_id: tight, tool: "sentiment", args: {} }, db, clockAt(T0 + 30), f2.fn);
    assert.equal(s3.admitted, false);
    assert.equal(s3.call.output_status, "budget");
    assert.equal(s3.call.latency_ms, null, "准入阶段被挡下、没打上游 ⇒ 计时是 null，写成 0 会冒充「跑过一次快回来的请求」");
    assert.equal(s3.http, 200, "被预算挡下也是这次运行的真实结果，不是接口出错");
    assert.equal(s3.next_turn.action, "stop");
    assert.equal(f2.calls.count, 2, "预算用完之后不得再打上游");
    const rows2 = await db.$queryRawUnsafe("SELECT COUNT(*) AS n FROM agent_tool_call WHERE runId=?", tight);
    assert.equal(Number((rows2[0] as { n: number }).n), 3, "被挡下的请求也要各写一行：§十八 要答得出「刚才请求了什么、为什么没跑」");
    assert.match(String(s3.basis), /本次没有执行/, "basis 必须说清这一步没执行");

    // 4b) 整轮总时长用尽 ⇒ 落库状态是 budget，不是 timeout：这一条压根没打上游，
    //     写成 timeout 会让页面说「这一次调用超时」，与同一行的「未执行任何取数」自相矛盾（§十七/§十八）。
    const slow = "mech-run-2t";
    await startAgentRun({ run_id: slow, question: "机制测试：整轮时长预算", budget: { max_total_ms: 1000 } }, db, clockAt(T0));
    const f2t = makeFakeTool(REAL_VALUE);
    const sT = await runAgentStep({ run_id: slow, tool: "radar", args: {} }, db, clockAt(T0 + 60000), f2t.fn);
    assert.equal(sT.admitted, false);
    assert.equal(sT.call.output_status, "budget", `整轮时长用尽应记 budget，实际 ${sT.call.output_status}`);
    assert.match(String(sT.call.error), /总时长预算/);
    assert.equal(f2t.calls.count, 0, "时长预算用尽之后一次上游也不该打");
    assert.equal(sT.next_turn.reason, "max_total_ms", "整轮停止原因走 max_total_ms，与单次调用的 timeout 分类各归各");

    // 5) 自然键 (runId, step)：同一行重发是覆盖，不是多出一步
    const dup = await db.agentToolCall.upsert({
      where: { runId_step: { runId: tight, step: 1 } },
      update: { summary: `${MK}重发的同一步` },
      create: { runId: tight, step: 1, tool: "radar", capability: "radar.findings", executor: "db.radar", outputStatus: "ok", timestamp: AT },
    });
    assert.equal(String(dup.summary), `${MK}重发的同一步`);
    const rows3 = await db.$queryRawUnsafe("SELECT COUNT(*) AS n FROM agent_tool_call WHERE runId=? AND step=1", tight);
    assert.equal(Number((rows3[0] as { n: number }).n), 1, "网络重试重发同一步不能变成两步");

    // 6) 收尾：答案引用台账里不存在的行 ⇒ REJECTED（422），原文与违规项都留档
    const badFinal = JSON.stringify({ thought: "够了", final: { answer: `${MK}结论：当日雷达 3 条`, cites: ["F77"], gaps: [] } });
    const f_bad = await finalizeAgentRun({ run_id: rid, raw: badFinal }, db, clockAt(T0 + 9000));
    assert.equal(f_bad.ok, false);
    assert.equal(f_bad.http, 422, "读了库也落了库，但结论不可回溯 ⇒ 422，不是 500");
    assert.equal(f_bad.persisted, true);
    assert.equal(f_bad.check?.status, "REJECTED");
    assert.ok((f_bad.check?.cites_invalid ?? []).includes("F77"), "编造的引用要逐条留档");
    assert.ok((f_bad.check?.violations ?? []).some((v) => /不存在的行/.test(v)));

    // 7) 收尾：合法引用 ⇒ ACCEPTED，且再次收尾不会把它抹掉
    const goodFinal = JSON.stringify({ thought: "够了", final: { answer: `${MK}结论：当日有雷达条目`, cites: ["F01"], gaps: ["缺资金流"] } });
    const noRun = await finalizeAgentRun({ run_id: "mech-run-3", raw: goodFinal }, db, clockAt(T0));
    assert.equal(noRun.http, 404, "没开过的 run 不能收尾（本层不会替你新建一条空运行凑答案）");
    assert.equal(noRun.persisted, false);
    const r3 = await startAgentRun({ run_id: "mech-run-3", question: "机制测试：可回溯结论" }, db, clockAt(T0));
    assert.equal(r3.ok, true);
    await runAgentStep({ run_id: "mech-run-3", tool: "radar", args: {} }, db, clockAt(T0 + 5), makeFakeTool(REAL_VALUE).fn);
    const f1 = await finalizeAgentRun({ run_id: "mech-run-3", raw: goodFinal }, db, clockAt(T0 + 6000));
    assert.equal(f1.http, 200, `ACCEPTED 却回了 ${f1.http}：${JSON.stringify(f1.check?.violations)}`);
    assert.equal(f1.check?.status, "ACCEPTED");
    assert.deepEqual(f1.check?.cites_valid, ["F01"]);
    assert.equal((f1.check?.lineage ?? [])[0]?.source, "fake://机制测试", "血缘要回到这一条实际走的源");
    const f2again = await finalizeAgentRun({ run_id: "mech-run-3", raw: JSON.stringify({ thought: "再试", final: { answer: `${MK}换一句没有引用的话`, cites: [], gaps: [] } }) }, db, clockAt(T0 + 7000));
    assert.equal(f2again.http, 409, "一次失败的回复不覆盖已成立的结论");
    assert.equal(f2again.persisted, false);
    const after = await db.agentRun.findUnique({ where: { runId: "mech-run-3" }, select: { answerStatus: true, answerText: true, status: true } });
    assert.equal(after?.answerStatus, "ACCEPTED", "库里那条结论必须还在");
    assert.match(String(after?.answerText), /有雷达条目/);
    assert.equal(after?.status, "finished");

    // 8) 收尾之后不再接受新的工具调用（否则时间线与「当时跑了什么」就答不出了）
    const late = await runAgentStep({ run_id: "mech-run-3", tool: "events", args: {} }, db, clockAt(T0 + 8000), makeFakeTool(REAL_VALUE).fn);
    assert.equal(late.http, 409);
    assert.equal(late.ok, false);
    assert.equal(late.admitted, false);

    // 9) 四种「没拿到读数」在日志里互不冒充（同一份机制库，换个执行器而已）
    for (const [i, obs] of [
      ["empty", emptyObs("机制：本次没有内容", "fake://机制测试")],
      ["failed", failedObs("机制：请求失败", "fake://机制测试", { timed_out: true })],
      ["covered", notCoveredObs("机制：该能力没有可靠来源", "fake://机制测试")],
    ] as const) {
      const rid4 = `mech-run-4-${i}`;
      await startAgentRun({ run_id: rid4, question: "机制测试：碰壁分类" }, db, clockAt(T0));
      const r = await runAgentStep({ run_id: rid4, tool: "radar", args: {} }, db, clockAt(T0 + 10), makeFakeTool(() => obs).fn);
      assert.equal(r.ok, true, `${i} 这一步照样记了账`);
      assert.equal(r.http, 200, `${i}：取数失败不是接口出错`);
      assert.equal(r.dead_end?.failure, i === "empty" ? "no_data" : i === "failed" ? "timeout" : "not_supported",
        `${i} 应归到自己那一类碰壁，压成同一类就没法回答「该重试还是该换源」`);
      assert.match(String(r.dead_end?.user_note), /兜底|无法验证/, "碰壁必须给下一步动作或标准缺口句式");
    }

    // 10) 状态重建：从库里读回来的 state 与当时内存里的计数一致（进程重启后仍能回看的前提）
    const loaded = await loadAgentRun(rid, db);
    assert.ok(loaded);
    assert.equal(loaded!.state.step, 2, "这一轮真实记了 2 步（第 3 步没跑成）");
    assert.equal(loaded!.state.tool_calls, 1);
    assert.equal(loaded!.state.evidence.length, 1);
    assert.deepEqual(loaded!.skipped, [], "机制行都该认得；不空说明落库与重建的分层口径漂了");
    const view = await agentRunView(rid, db, clockAt(T0 + 99000));
    assert.equal(view.ok, true);
    assert.equal(view.http, 200);
    const rc = view.rebuild_check as { stored: Record<string, number>; rebuilt: Record<string, number>; consistent: boolean };
    assert.equal(rc.consistent, true, `库里存的计数与重建出来的不等：${JSON.stringify(rc)}`);
    assert.equal(view.answer_status, "REJECTED", "回看读的是落库时那份判定");
    assert.ok(Array.isArray(view.timeline) && (view.timeline as unknown[]).length === 2);
    assert.equal(view.status, "finished");

    // 11) 列表 + 404 口径
    const list = await listAgentRuns(db, 50);
    assert.ok(list.some((r) => r.run_id === rid), "跑过的运行要能在列表里读到");
    assert.ok(list.every((r) => typeof r.started_at === "string"));
    const missing = await agentRunView("never-opened", db, clockAt(T0));
    assert.equal(missing.ok, false);
    assert.equal(missing.http, 404, "「从没开过」与「跑过但没结果」是两件事");
    assert.match(String(missing.error), /找不到 run_id/, "错误原文要写明是没找到这个 run");
    const badId = await agentRunView("bad id/../..", db, clockAt(T0));
    assert.equal(badId.http, 400, "参数不合法不该回 404");

    // 12) 数据状态口径没被这层放宽
    const allStatus = await db.$queryRawUnsafe("SELECT DISTINCT dataStatus AS d FROM agent_tool_call WHERE runId LIKE 'mech-run%'");
    for (const r of allStatus) {
      const d = String(r.d ?? "");
      assert.ok(d === "" || DATA_STATUSES.includes(d as (typeof DATA_STATUSES)[number]), `落库出现口径外的 dataStatus：${d}`);
    }
  } finally {
    await db.$disconnect();
    fs.rmSync(tmp, { force: true });
    assert.deepEqual(statOf(DB_FILE), before, "真实库文件被改动：机制测试只允许跑在副本上");
  }
});
