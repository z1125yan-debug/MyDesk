// Phase 1 框架测试：DataProvider 契约（演示源）+ Job Registry（进度/暂停/恢复/失败/去重）
// 运行：node --test tests/quant/ （Node ≥24 原生直跑 .ts）
import { test } from "node:test";
import assert from "node:assert/strict";
import { demoProvider, DEMO_TRADING_DAYS, DEMO_UNIVERSE_SIZE } from "../../src/lib/quant/data/demo-provider.ts";
import { applyUniverseFilters, assertProviderContract } from "../../src/lib/quant/data/provider.ts";
import {
  startJob, pauseJob, resumeJob, cancelJob, getJob, listJobs, registerRunner,
  findByFingerprint, JOB_PAUSED, JOB_CANCELLED,
} from "../../src/lib/quant/jobs/registry.ts";
import type { JobCtx } from "../../src/lib/quant/jobs/registry.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- DataProvider：演示源 ----------

test("demo provider: 宇宙固定且确定，asOf 之前未上市股票被剔除", async () => {
  const early = await demoProvider.listUniverse({ kind: "all" }, "2024-06-28");
  const late = await demoProvider.listUniverse({ kind: "all" }, "2025-08-01");
  assert.equal(DEMO_UNIVERSE_SIZE, 60);
  assert.equal(early.length, 59); // 2025-06 上市的那只在 2024-06 不存在
  assert.equal(late.length, 60);
  assert.ok(early.every((m) => !m.listDate || m.listDate <= "2024-06-28"));
});

test("demo provider: 同种子两次取数完全一致（确定性）", async () => {
  const [a, b] = await Promise.all([
    demoProvider.getBars({ symbols: ["601000.SH"], tf: "day", asOf: "2025-12-31", lookback: 100 }),
    demoProvider.getBars({ symbols: ["601000.SH"], tf: "day", asOf: "2025-12-31", lookback: 100 }),
  ]);
  assert.deepEqual(a.get("601000.SH"), b.get("601000.SH"));
  assert.equal(a.get("601000.SH")!.length, 100);
});

test("demo provider: asOf 严格截断，绝不返回未来数据", async () => {
  const asOf = "2024-12-31";
  const bars = await demoProvider.getBars({ symbols: ["601000.SH", "001020.SZ"], tf: "day", asOf, lookback: 500 });
  for (const [sym, arr] of bars) {
    assert.ok(arr.length > 0, `${sym} 应有数据`);
    for (const b of arr) assert.ok(b.date <= asOf, `${sym} 出现未来数据 ${b.date}`);
  }
  // 2025-06-10 才上市的演示股（681059.SH）在 2025-01-01 不应有任何K线
  const early = await demoProvider.getBars({ symbols: ["681059.SH"], tf: "day", asOf: "2025-01-01", lookback: 30 });
  assert.equal(early.get("681059.SH")!.length, 0);
});

test("demo provider: 过滤器（ST/停牌/上市天数/市值）与选股共用同一实现", async () => {
  const metas = await demoProvider.listUniverse({ kind: "all" }, "2025-08-01");
  const { kept, excluded } = applyUniverseFilters(metas, "2025-08-01", {
    excludeST: true, minListDays: 400, minMarketCap: 50e8,
  });
  assert.ok(excluded.st >= 1, "应至少剔除 1 只 ST");
  assert.ok(kept.every((m) => !m.st));
  assert.ok(kept.every((m) => (m.marketCap ?? 0) >= 50e8));
});

test("demo provider: 行业/概念/自定义股票池", async () => {
  const industry = await demoProvider.listUniverse({ kind: "industry", boardCode: "半导体" }, "2025-08-01");
  assert.ok(industry.length > 0 && industry.length < 60);
  assert.ok(industry.every((m) => m.industry === "半导体"));
  const custom = await demoProvider.listUniverse({ kind: "custom", symbols: ["601000.SH"] }, "2025-08-01");
  assert.equal(custom.length, 1);
  assert.equal(custom[0].symbol, "601000.SH");
});

test("provider contract: demo 源通过通用契约自检", async () => {
  const problems = await assertProviderContract(demoProvider, "2025-08-01");
  assert.deepEqual(problems, []);
});

test("交易日历：工作日序列", () => {
  assert.ok(DEMO_TRADING_DAYS.length >= 700);
  assert.equal(DEMO_TRADING_DAYS[0], "2024-01-02");
});

// ---------- Job Registry ----------

async function waitForJobStatus(id: string, want: string | string[], timeoutMs = 3000): Promise<void> {
  const wants = Array.isArray(want) ? want : [want];
  const start = Date.now();
  for (;;) {
    const job = getJob(id);
    if (job && wants.includes(job.status)) return;
    if (Date.now() - start > timeoutMs) {
      assert.fail(`任务 ${id} 在 ${timeoutMs}ms 内未达到状态 ${wants.join("/")}（当前 ${job?.status}，error=${job?.error}）`);
    }
    await sleep(10);
  }
}

test("job registry: 运行到完成，进度与结果落盘", async () => {
  registerRunner("test-finish", async (ctx: JobCtx) => {
    for (let i = 1; i <= 5; i++) {
      if (ctx.paused() || ctx.cancelled()) return JOB_PAUSED;
      ctx.progress(i * 20, "step", `第 ${i} 步`);
      await sleep(5);
    }
    return { answer: 42 };
  });
  const { job, duplicate } = startJob({ kind: "test-finish", fingerprint: "fp-finish" });
  assert.equal(duplicate, false);
  await waitForJobStatus(job.id, "done");
  const done = getJob(job.id)!;
  assert.equal(done.progress, 100);
  assert.deepEqual(done.result, { answer: 42 });
  assert.equal(done.stage, "step");
});

test("job registry: 同指纹运行中不重复执行", async () => {
  registerRunner("test-dedup", async () => {
    await sleep(120);
    return { ok: true };
  });
  const first = startJob({ kind: "test-dedup", fingerprint: "fp-dedup" });
  const second = startJob({ kind: "test-dedup", fingerprint: "fp-dedup" });
  assert.equal(second.duplicate, true);
  assert.equal(second.job.id, first.job.id);
  await sleep(200);
});

test("job registry: 暂停 → 断点保存 → 恢复 → 完成", async () => {
  let executedLast = -1;
  registerRunner("test-pause", async (ctx: JobCtx) => {
    const cp = ctx.loadCheckpoint() as { done: number } | null;
    const from = cp?.done ?? 0;
    for (let i = from; i < 10; i++) {
      if (ctx.paused()) { ctx.saveCheckpoint({ done: i }); return JOB_PAUSED; }
      if (ctx.cancelled()) return JOB_CANCELLED;
      executedLast = i + 1;
      ctx.progress((i + 1) * 10, "loop", `chunk ${i + 1}/10`);
      await sleep(15);
    }
    return { last: executedLast };
  });
  const { job } = startJob({ kind: "test-pause", fingerprint: "fp-pause" });
  await sleep(45); // 跑 2~3 个分片
  assert.ok(pauseJob(job.id), "暂停请求应成功");
  await waitForJobStatus(job.id, "paused");
  const paused = getJob(job.id)!;
  assert.ok(paused.progress > 0 && paused.progress < 100, `进度应停在中间：${paused.progress}`);

  assert.ok(await resumeJob(job.id), "恢复应成功");
  await waitForJobStatus(job.id, "done");
  const done = getJob(job.id)!;
  assert.equal(done.progress, 100);
  assert.equal(done.result.last, 10);
});

test("job registry: 失败必须留下失败原因", async () => {
  registerRunner("test-fail", async () => {
    throw new Error("数据不足：样本小于 60 根");
  });
  const { job } = startJob({ kind: "test-fail", fingerprint: "fp-fail" });
  await waitForJobStatus(job.id, "failed");
  const failed = getJob(job.id)!;
  assert.ok(failed.error.includes("数据不足"), `error 应含原因：${failed.error}`);
});

test("job registry: 取消", async () => {
  registerRunner("test-cancel", async (ctx: JobCtx) => {
    for (let i = 0; i < 20; i++) {
      if (ctx.cancelled()) return JOB_CANCELLED;
      await sleep(10);
    }
    return {};
  });
  const { job } = startJob({ kind: "test-cancel", fingerprint: "fp-cancel" });
  await sleep(20);
  assert.ok(cancelJob(job.id));
  await waitForJobStatus(job.id, "cancelled");
});

test("job registry: findByFingerprint 与列表", async () => {
  const hit = findByFingerprint("test-dedup", "fp-dedup");
  assert.ok(hit, "应找到已完成任务");
  assert.equal(hit!.fingerprint, "fp-dedup");
  assert.ok(listJobs().length >= 5);
});
