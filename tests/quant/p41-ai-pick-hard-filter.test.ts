// P41 · AI 优选硬过滤 + 版本化单测（只算不改代码的回溯验证后，确定性过滤落代码层）。
// 口径：换手>10%且涨幅<3% = 派发嫌疑；主力<0且价涨 = 背离；数据缺失（null）不触发。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyHardFilter,
  hardFilterReason,
  narrowChoices,
  type AiPickCandidate,
} from "../../src/lib/quant/strategy/ai-pick-core.ts";
import {
  appendAiPickVersion,
  latestVersionDecisionDateBefore,
  listAiPickVersions,
} from "../../src/lib/quant/strategy/ai-pick-versions.ts";

const xiehe: AiPickCandidate = {
  symbol: "605258.SH", name: "协和电子",
  changePct: 2.46, turnoverPct: 14.45, fundNetYi: 0.03,
};
const jinhui: AiPickCandidate = {
  symbol: "603919.SH", name: "金徽酒",
  changePct: 3.25, turnoverPct: 4.18, fundNetYi: -0.1,
};
const hengrui: AiPickCandidate = {
  symbol: "600276.SH", name: "恒瑞医药",
  changePct: 2.44, turnoverPct: 1.0, fundNetYi: 2.12,
};
const noData: AiPickCandidate = {
  symbol: "601001.SH", name: "晋控煤业",
  changePct: -1.39, turnoverPct: 1.18, fundNetYi: null,
};

test("硬过滤：协和电子（高换手小涨幅）被拦，金徽酒（主力流出+价涨）被拦，恒瑞通过", () => {
  assert.match(hardFilterReason(xiehe) ?? "", /派发/);
  assert.match(hardFilterReason(jinhui) ?? "", /背离/);
  assert.equal(hardFilterReason(hengrui), null);
});

test("硬过滤：数据缺失不触发（主力 null 的晋控不被背离规则拦）", () => {
  assert.equal(hardFilterReason(noData), null);
  const { kept, rejected } = applyHardFilter([xiehe, jinhui, hengrui, noData]);
  assert.deepEqual(kept.map((c) => c.symbol), ["600276.SH", "601001.SH"]);
  assert.deepEqual(rejected.map((r) => r.symbol), ["605258.SH", "603919.SH"]);
  assert.ok(rejected.every((r) => r.reason.length > 0));
});

test("第二道过滤：模型硬选协和电子也被 narrowChoices 拦掉", () => {
  const out = narrowChoices(
    [{ symbol: "605258.SH", reason: "模型硬选" }, { symbol: "600276.SH", reason: "正常" }],
    [xiehe, hengrui],
    10,
  );
  assert.deepEqual(out.map((c) => c.symbol), ["600276.SH"]);
});

test("版本化：同一决策日跑两次产生两个版本，绝不覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-pick-versions-"));
  await appendAiPickVersion(
    { tradeDate: "2026-10-15", runAt: "2026-10-16 07:09:10", picks: [{ symbol: "600276.SH", name: "恒瑞医药", changePct: 2.44 }], source: "auto" },
    dir,
  );
  await appendAiPickVersion(
    { tradeDate: "2026-10-15", runAt: "2026-10-16 07:09:10", picks: [{ symbol: "603919.SH", name: "金徽酒", changePct: 3.25 }], source: "auto" },
    dir,
  );
  const files = (await readdir(dir)).sort();
  assert.equal(files.length, 2); // 同秒第二次加 -2 后缀，不覆盖第一次
  const list = await listAiPickVersions("2026-10-15", dir);
  assert.equal(list.length, 2);
  // 第一个文件内容还在（没被覆盖）：不带 -2 后缀的是第一次写入
  const firstName = files.find((f) => !f.includes("-2.json")) ?? "";
  const first = JSON.parse(await readFile(join(dir, firstName), "utf-8")) as { picks: { symbol: string }[] };
  assert.equal(first.picks[0].symbol, "600276.SH");
  // 两版都在
  assert.deepEqual(
    list.flatMap((v) => v.picks.map((p) => p.symbol)).sort(),
    ["600276.SH", "603919.SH"],
  );
});

test("快照票池决策日：取今天之前最近一个有版本的决策日", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-pick-versions-"));
  await appendAiPickVersion(
    { tradeDate: "2026-10-15", runAt: "2026-10-16 07:09:10", picks: [], source: "auto" },
    dir,
  );
  await appendAiPickVersion(
    { tradeDate: "2026-10-16", runAt: "2026-10-16 15:20:00", picks: [], source: "auto" },
    dir,
  );
  // 今天是 10-17 时，最近决策日是 10-16；今天是 10-16 时，最近是 10-15（今天的版本不算）
  assert.equal(await latestVersionDecisionDateBefore("2026-10-17", dir), "2026-10-16");
  assert.equal(await latestVersionDecisionDateBefore("2026-10-16", dir), "2026-10-15");
  assert.equal(await latestVersionDecisionDateBefore("2026-10-15", dir), null);
});
