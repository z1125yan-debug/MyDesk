// P3 第三阶段 增量扫描内核单测（纯函数，无网络/无 DB → 常规回归必跑，不允许 skipped 蒙混）
// 覆盖：自然键稳定性、内容指纹、Radar/Events 增量规划（新增/变化/未变/消失）、同批撞键不重复插、
//       首次与增量口径的判定、游标只在成功后推进、失败后下次仍会处理同一批数据（断点恢复）、
//       重复扫描不产生重复行、键集合裁剪只丢优化不丢数据、映射表变更后旧「未命中」记录失效。
//
// 为什么可以只测纯函数（REAL_DATA_ONLY 口径）：真实行情与快讯不可控，无法按需造出「恰好重复」「恰好失败一半」
// 的分支；用真实数据撞这些分支等于把验收交给运气。真实链路（扫描→落库→读回、不重复、跨日安全）的对拍见
// tests/quant/p2-scan-loop.test.ts，本阶段增量的真实数据验收同文件（见 worklog 的「机制验收 / 真实数据验收」拆分）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CURSOR_KEYS, MODE_TEXT, advanceCursor, boundedKey, contentHash, cursorCommitsNothing, decideMode,
  eventKeyOf, eventNaturalKey, freshUnmatched, isFirstRun, modeBasisLabel, modeFromBasis, newsFingerprint,
  planEventDelta, planRadarDelta,
  radarKeyOf, radarNaturalKey, setFingerprint, staleUnmatched, unmatchedKeyWithBasis,
  type CursorLite, type ExistingRowLite,
} from "../../src/lib/quant/screener/incremental-core.ts";

const radar = (kind: string, title: string, detail: string, evidence: Record<string, unknown> = {}) =>
  ({ kind, title, detail, evidence });
const asRadarItems = (items: { kind: string; title: string; detail: string; evidence: Record<string, unknown> }[]) =>
  items.map((i) => radarKeyOf(i));
const cursorOf = (doneKeys: Record<string, string>, unmatched: string[] = [], watermark = "wm"): CursorLite =>
  ({ watermark, doneKeys, scannedUnmatched: unmatched, updatedAt: 1 });

test("自然键稳定：同一信号重复计算键一致，标题多余空白不影响", () => {
  const a = radar("theme", "主线：半导体 芯 片", "涨 3%", { code: "BK1036" });
  const b = radar("theme", " 主线：半导体 芯  片 ", "涨 5%", { code: "BK1036" });
  assert.equal(radarNaturalKey(a), radarNaturalKey(b), "首尾空白去掉、连续空白压成一个空格：排版差异不得变成两条信号");
  assert.notEqual(contentHash({ detail: a.detail, evidence: a.evidence }), contentHash({ detail: b.detail, evidence: b.evidence }),
    "键相同但内容不同 ⇒ 必须能靠内容指纹区分（否则变化会被当成未变）");
});

test("自然键不合并不同信号：kind / 标的 / 事件标识任一不同就是两条", () => {
  const keys = new Set([
    radarNaturalKey(radar("theme", "主线：半导体", "", { code: "BK1036" })),
    radarNaturalKey(radar("fund", "主线：半导体", "", { code: "BK1036" })),
    radarNaturalKey(radar("theme", "主线：半导体", "", { code: "BK0448" })),
    radarNaturalKey(radar("theme", "主线：军工", "", { code: "BK1036" })),
  ]);
  assert.equal(keys.size, 4);
  // 没有标的的事件类信号靠 eventKey / level 区分
  assert.notEqual(radarNaturalKey(radar("news", "A", "", { eventKey: "e1" })), radarNaturalKey(radar("news", "A", "", { eventKey: "e2" })));
});

test("带实时数值、无标的可依赖的信号：数值变化走更新，不会被当成「新信号 + 旧信号消失」", () => {
  const first = radar("anomaly", "风险提示：炸板率 45%", "触板 20 / 炸板 9", { break_rate: 45 });
  const later = radar("anomaly", "风险提示：炸板率 52%", "触板 25 / 炸板 13", { break_rate: 52 });
  const key = radarNaturalKey(first);
  assert.equal(key, radarNaturalKey(later), "同一类异常信号必须保持同一条（否则每次扫描刷屏一行）");
  const d = planRadarDelta([first], [{ id: "r1", dedupeKey: key, contentHash: "stale" }]);
  assert.equal(d.insert.length, 0);
  assert.equal(d.supersedeIds.length, 0, "数值一变就把旧行判成「已消失」是错的：应走内容更新");
  assert.equal(d.update.length, 1);
  assert.equal(d.update[0].id, "r1", "更新必须原地改，保留 id 与首次出现时刻");
  // 但不同种类的异常不会被抹平：涨跌家数比与炸板率是两条信号
  assert.notEqual(key, radarNaturalKey(radar("anomaly", "异常信号：涨跌家数比 0.42", "", { advRatio: 0.42 })));
});

test("内容指纹：与键顺序无关、对内容敏感；一批候选的整体指纹与顺序无关", () => {
  assert.equal(contentHash({ a: 1, b: { c: 2, d: [3, 4] } }), contentHash({ b: { d: [3, 4], c: 2 }, a: 1 }));
  assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
  assert.match(contentHash({ a: 1 }), /^[0-9a-f]{12}$/);
  const list = ["x", "y", "z"].map((t) => radar("theme", `主线：${t}`, "", { code: t }));
  assert.equal(setFingerprint(list, radarNaturalKey), setFingerprint([...list].reverse(), radarNaturalKey));
  assert.notEqual(setFingerprint(list, radarNaturalKey), setFingerprint(list.slice(0, 2), radarNaturalKey));
});

test("快讯指纹与事件键：上游无 id，只能用「时间 + 标题」；超长键压成定长", () => {
  assert.equal(newsFingerprint(" 09:30 ", "甲  方"), "09:30|甲 方", "首尾空白去掉、中间连续空白压成一个空格");
  assert.equal(eventNaturalKey({ time: "09:30", title: "甲方宣布  涨价" }), eventNaturalKey({ time: "09:30", title: " 甲方宣布 涨价 " }));
  const long = eventNaturalKey({ time: "09:30", title: "长".repeat(400) });
  assert.ok(long.length <= 200, `键必须定长（实际 ${long.length}）`);
  assert.equal(long, eventNaturalKey({ time: "09:30", title: "长".repeat(400) }));
  assert.notEqual(long, eventNaturalKey({ time: "09:30", title: "长".repeat(399) + "短" }));
});

test("键/指纹只有一个实现：写入路径与「老行回填」算出来的必须一致", () => {
  const it = radar("theme", "主线：半导体", "涨 3%", { code: "BK1036", changePct: 3.2 });
  const direct = radarKeyOf(it);
  assert.equal(direct.dedupeKey, boundedKey(radarNaturalKey(it)));
  assert.equal(direct.contentHash, contentHash({ detail: it.detail, evidence: it.evidence }));
  // 规划产物的键必须等于直接对同一候选调用 radarKeyOf（落库层写键时用的就是后者）
  const planned = planRadarDelta([it], []);
  assert.equal(planned.insert[0].dedupeKey, direct.dedupeKey);
  assert.equal(planned.insert[0].contentHash, direct.contentHash);

  // 事件：JSON 列反序列化回来（数组/对象重新组装）必须算出同一指纹，否则回填会把每条老行都误判成「已变化」
  const ev = eventKeyOf({
    time: "09:30", title: "甲方涨价", level: "行业新闻", category: "产业",
    mappedSectors: ["半导体", "PCB"], relatedStocks: ["沪电"], fundCheck: { stage: "已验证", boards: [{ name: "半导体", changePct: 3.2 }] },
    stage: "已验证", source: "东财7x24",
  });
  const roundTripped = eventKeyOf(JSON.parse(JSON.stringify({
    time: "09:30", title: "甲方涨价", level: "行业新闻", category: "产业",
    mappedSectors: ["半导体", "PCB"], relatedStocks: ["沪电"], fundCheck: { boards: [{ changePct: 3.2, name: "半导体" }], stage: "已验证" },
    stage: "已验证", source: "东财7x24",
  })));
  assert.deepEqual(roundTripped, ev, "对象键顺序不得影响指纹（canonical 序列化）：否则回填会全量误判为变化");
});

test("Radar 增量规划：首次全部新增；重复扫描全部未变；内容变化才更新；算不出的旧行标记消失", () => {
  const items = [radar("risk", "市场风险等级：中", "t1", { level: "中" }), radar("theme", "主线：半导体", "t2", { code: "BK1036" })];
  const first = planRadarDelta(items, []);
  assert.equal(first.insert.length, 2);
  assert.equal(first.supersedeIds.length, 0);
  assert.deepEqual(first.update, []);

  // 第二次扫描：同一天同一批数据（模拟「上游没变」）→ 与库里已有行逐条对上，全部 unchanged
  const stored: ExistingRowLite[] = first.insert.map((i) => ({ id: `id-${i.dedupeKey}`, dedupeKey: i.dedupeKey, contentHash: i.contentHash }));
  const again = planRadarDelta(items, stored);
  assert.equal(again.insert.length, 0, "重复扫描不得再插行");
  assert.equal(again.update.length, 0);
  assert.equal(again.unchanged, 2);
  assert.equal(again.supersedeIds.length, 0, "全部信号仍在产出，不该有行被判成消失");

  // 半导体涨幅刷新，风险等级不变 → 只更新那一行
  const changed = [items[0], radar("theme", "主线：半导体", "t2-新", { code: "BK1036" })];
  const d = planRadarDelta(changed, stored);
  assert.equal(d.insert.length, 0);
  assert.equal(d.unchanged, 1);
  assert.equal(d.update.length, 1);
  assert.equal(d.update[0].title, "主线：半导体");

  // 炸板率信号本次不再触发（候选里消失）→ 标 superseded，不物理删除
  const withAnomaly = [...items, radar("anomaly", "风险提示：炸板率 45%", "t3", { break_rate: 45 })];
  const d2 = planRadarDelta(changed, [...stored, ...planRadarDelta(withAnomaly.slice(2), []).insert
    .map((i) => ({ id: "an1", dedupeKey: i.dedupeKey, contentHash: i.contentHash }))]);
  assert.deepEqual(d2.supersedeIds, ["an1"]);
  assert.equal(d2.candidates, 2);
});

test("Radar 消失与复活：只标记当前 live 行；信号再次算出时原地复活，不再插第二行", () => {
  const a = radar("theme", "主线：半导体", "A", { code: "BK1036" });
  const key = radarNaturalKey(a);
  const hash = contentHash({ detail: "A", evidence: { code: "BK1036" } });
  const rows: ExistingRowLite[] = [{ id: "row1", dedupeKey: key, contentHash: hash, state: "superseded" }];
  // 该信号上次被标记为已消失，本次又算出来了 → 走更新（把 state 改回 live），不得再插一行
  const d = planRadarDelta([a], rows);
  assert.equal(d.insert.length, 0, "复活不得产生重复行");
  assert.equal(d.update.length, 1);
  assert.equal(d.update[0].id, "row1");
  assert.equal(d.unchanged, 0, "内容一样但状态不同：仍算「需要写」，不能被判成无事可做");
  // 上次已标记消失、本次仍没算出来 → 不重复标记（否则每次扫描都往 supersedeIds 里塞同一行）
  const d2 = planRadarDelta([radar("risk", "市场风险等级：中", "x", { level: "中" })], rows);
  assert.deepEqual(d2.supersedeIds, [], "已消失的行不得重复计入本次消失数");
});

test("Radar 同批撞键：两条链路产出同一条时合并成一行，不重复插", () => {
  const dup = [radar("theme", "主线：半导体", "A", { code: "BK1036" }), radar("theme", "主线：半导体", "B", { code: "BK1036" })];
  const d = planRadarDelta(dup, []);
  assert.equal(d.candidates, 2, "候选数如实回报（上游确实产出了两条）");
  assert.equal(d.insert.length, 1, "同一批里撞键只能落一行");
  assert.equal(d.insert[0].detail, "B", "后到的内容覆盖前者，与「当日先删后插」的最终口径一致");
  const dupInDb = [{ id: "s1", dedupeKey: d.insert[0].dedupeKey, contentHash: contentHash({ detail: "旧", evidence: { code: "BK1036" } }) }];
  const d2 = planRadarDelta(dup, dupInDb);
  assert.equal(d2.insert.length, 0);
  assert.equal(d2.update.length, 1, "撞键且库里已有该键 → 走更新而不是新增");
  assert.equal(d2.update[0].id, "s1");
});

test("Events 增量规划：滑出窗口≠消失，已入库事件一律保留", () => {
  const mk = (t: string, title: string, stage: string) => ({
    time: t, title, level: "行业新闻", category: "产业",
    mappedSectors: ["半导体"], relatedStocks: ["沪电"], fundCheck: { stage }, stage, source: "东财7x24/新浪快讯 + 手工映射表 + 东财板块资金",
  });
  const items = [mk("09:30", "甲方涨价", "已验证"), mk("10:00", "乙方扩产", "无资金验证")];
  const first = planEventDelta(items, []);
  assert.equal(first.insert.length, 2);
  assert.equal(first.insert[0].fields.stage, "已验证", "规划结果必须带上落库字段，落库层不再自己拼一遍");
  const stored = first.insert.map((i) => ({ id: `e-${i.dedupeKey}`, dedupeKey: i.dedupeKey, contentHash: i.contentHash }));
  // 第二次：窗口滚动，09:30 那条滑出窗口，只剩 10:00 → 已入库的 09:30 必须保留（事件表没有 supersede）
  const d = planEventDelta([items[1]], stored);
  assert.equal(d.insert.length, 0);
  assert.equal(d.unchanged, 1);
  assert.equal(d.kept, 1, "滑出上游窗口的已入库事件不得被删除或标记消失");
  assert.equal((d as unknown as { supersedeIds?: unknown }).supersedeIds, undefined, "事件规划不得提供删除口径");
  // 同一批里上游重复推送同一条快讯 → 只落一条
  const dup = planEventDelta([items[0], { ...items[0], fundCheck: { stage: "已验证" } }], []);
  assert.equal(dup.insert.length, 1);
  // 资金验证结论刷新 → 同一键走更新，不插第二行
  const d2 = planEventDelta([mk("09:30", "甲方涨价", "资金强")], stored);
  assert.equal(d2.insert.length, 0);
  assert.equal(d2.update.length, 1);
  assert.equal(d2.update[0].id, stored[0].id);
});

test("口径判定：无游标/跨交易日走全量，有当日游标走增量，人工强制点击走全量，显式指定优先", () => {
  const c = cursorOf({ k1: "h1" });
  assert.equal(isFirstRun(null, "2026-09-21", null), true);
  assert.equal(isFirstRun(c, "2026-09-21", "2026-09-18"), true, "昨天的游标不能跳过今天的新数据");
  assert.equal(isFirstRun(c, "2026-09-21", "2026-09-21"), false);
  assert.equal(isFirstRun(cursorOf({}), "2026-09-21", "2026-09-21"), true, "空游标等于没跑过");

  assert.equal(decideMode({ cursor: null, tradeDate: "2026-09-21", cursorTradeDate: null }), "full");
  assert.equal(decideMode({ cursor: c, tradeDate: "2026-09-21", cursorTradeDate: "2026-09-21" }), "incremental");
  assert.equal(decideMode({ cursor: c, tradeDate: "2026-09-21", cursorTradeDate: "2026-09-18" }), "full");
  assert.equal(decideMode({ force: true, cursor: c, tradeDate: "2026-09-21", cursorTradeDate: "2026-09-21" }), "full",
    "手动点「立即扫描」= 用户要求真跑一遍，不允许被游标跳过");
  assert.equal(decideMode({ force: true, mode: "incremental", cursor: c, tradeDate: "2026-09-21", cursorTradeDate: "2026-09-21" }), "incremental",
    "显式指定增量（补跑接口）时不被 force 改回全量");
  assert.equal(MODE_TEXT.incremental.includes("增量"), true);
  assert.equal(MODE_TEXT.full.includes("先删后插"), true);
});

test("游标只在成功后推进：失败不写游标，下次仍会处理同一批数据（断点恢复）", () => {
  const items = [radar("theme", "主线：半导体", "A", { code: "BK1036" }), radar("theme", "主线：军工", "B", { code: "BK0900" })];
  const planned = asRadarItems(items);
  const before = cursorOf({});

  // 本次运行「跑到一半失败」：实现上不会调用 advanceCursor（见 incremental.ts：仅事务提交成功后推进），
  // 游标因此保持原样 —— 必须仍判定为「有东西要写」，否则这批数据就被永久跳过了。
  assert.equal(cursorCommitsNothing(before, { watermark: "wm2", liveCount: 2 }), false,
    "失败后游标未推进 ⇒ 下次必须继续处理同一批数据，不允许永久跳过");

  // 下次成功：水位线 + 全部键并入游标 → 同一批数据再来一次，直接判定「无事可做」
  const next = advanceCursor(before, { watermark: "wm2", doneKeys: Object.fromEntries(planned.map((p) => [p.dedupeKey, p.contentHash])) });
  assert.equal(Object.keys(next.doneKeys).length, 2);
  assert.equal(next.watermark, "wm2");
  assert.equal(cursorCommitsNothing(next, { watermark: "wm2", liveCount: 2 }), true, "同一批数据重复扫描不再重写（幂等的实现点）");

  // 内容变化 → 整体指纹变化 → 游标不能挡路
  const changed = asRadarItems([radar("theme", "主线：半导体", "A-新", { code: "BK1036" }), items[1]]);
  const wm2 = setFingerprint(changed, (p) => `${p.dedupeKey}:${p.contentHash}`);
  const wm1 = setFingerprint(planned, (p) => `${p.dedupeKey}:${p.contentHash}`);
  assert.notEqual(wm2, wm1, "候选集合指纹必须能区分内容变化");
  assert.equal(cursorCommitsNothing(next, { watermark: wm2, liveCount: 2 }), false,
    "内容变了就必须走写入路径（游标只挡「完全没变」的那一批）");

  // 完整性校验：库内行数与游标键数不符（行被外部删过）→ 不接受游标的「无事可做」结论，回落到逐条比对
  assert.equal(cursorCommitsNothing(next, { watermark: "wm2", liveCount: 1 }), false,
    "「游标说已确认、库里其实缺行」必须被拦下，否则会静默丢数据");
  // 空水位线不得把已有水位线抹掉
  assert.equal(advanceCursor(next, { watermark: "" }).watermark, "wm2");
});

test("游标裁剪：只丢最早的键，且丢的只是跳过优化 —— 库里已有的行仍被识别为未变", () => {
  const items = Array.from({ length: 6 }, (_, i) => radar("theme", `主线：板块${i}`, `d${i}`, { code: `BK${i}` }));
  const planned = asRadarItems(items);
  let cur = advanceCursor(null, {
    watermark: "w",
    doneKeys: Object.fromEntries(planned.map((p) => [p.dedupeKey, p.contentHash])),
    cap: 3,
  });
  assert.equal(Object.keys(cur.doneKeys).length, 3, "超过上限必须裁剪");
  const kept = Object.keys(cur.doneKeys);
  assert.deepEqual(kept, planned.slice(3).map((p) => p.dedupeKey), "裁剪保留最近的键（丢弃最早插入的）");
  assert.equal(cursorCommitsNothing(cur, { watermark: "w", liveCount: 6 }), false,
    "游标被裁剪后不再相信「无事可做」→ 回落到库内逐条比对");
  // 重新进入队列 ≠ 重复落库：库里已有这些行，规划阶段按内容指纹判为 unchanged
  const stored: ExistingRowLite[] = planned.map((p) => ({ id: `id-${p.dedupeKey}`, dedupeKey: p.dedupeKey, contentHash: p.contentHash }));
  const d = planRadarDelta(items, stored);
  assert.equal(d.insert.length, 0, "裁剪后重复扫描仍不得产生重复行");
  assert.equal(d.unchanged, 6);
  assert.equal(MAX_CURSOR_KEYS, 3000);
});

test("未命中记录带映射表指纹：改了映射表就必须重新判定", () => {
  const fp = newsFingerprint("09:30", "与产业链无关的消息");
  const cur = advanceCursor(null, { watermark: "w", unmatchedKeys: [unmatchedKeyWithBasis(fp, "map-v1")] });
  assert.equal(freshUnmatched(cur, "map-v1").has(fp), true, "映射表未变时，未命中的快讯可以永久跳过重算");
  assert.equal(freshUnmatched(cur, "map-v2").has(fp), false, "映射表变了，旧的「未命中」结论不得继续生效");
  assert.deepEqual(staleUnmatched(cur, "map-v2"), [unmatchedKeyWithBasis(fp, "map-v1")]);
  assert.equal(freshUnmatched(null, "map-v1").size, 0);
  // 未命中键同样受上限裁剪约束
  const many = Array.from({ length: 5 }, (_, i) => unmatchedKeyWithBasis(`u${i}`, "m"));
  const trimmed = advanceCursor(null, { watermark: "w", unmatchedKeys: many, cap: 2 });
  assert.deepEqual(trimmed.scannedUnmatched, ["m:u3", "m:u4"]);
});

test("口径文案写读同源：落库时怎么写、页面就怎么读，读不出来就明说未记录", () => {
  // task_run.basis / scan_cursor.basis 都由 modeBasisLabel 写，前端用 modeFromBasis 读回同一份文案
  const inc = `上证指数日线截至 2026-09-19；${modeBasisLabel("incremental")}：候选 9 条 → 新增 1`;
  assert.equal(modeFromBasis(inc), "incremental");
  assert.equal(MODE_TEXT[modeFromBasis(inc) as "full" | "incremental"].includes("增量"), true);
  const full = `交易日确证；${modeBasisLabel("full")}；来源 computeSentiment`;
  assert.equal(modeFromBasis(full), "full");
  assert.equal(modeFromBasis("交易日尚未确证，未执行扫描"), "", "P3 之前的历史记录读不出口径时必须返回空串，页面得显示「未记录」而不是猜");
});
