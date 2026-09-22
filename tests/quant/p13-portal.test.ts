// P13 量化门户轮：Tab 收敛 + 因子 pill 中文化 + 候选池「存池交 AI 择优」出口 — 2026-09-22
// 背景：稳智《量化板块改造方案》的诊断是「八个平铺 Tab 把主路径淹了」——闭环其实已有零件
// （选股页冻结池、PoolPage 次日验证、工具环），缺的是①门户层级（主入口/专业工具/系统三组，
// 一条不删）；②因子 pill 直接印 factorKey@version（存储协议当用户语言）；③「存池→交 AI 择优
// →五段式结论」这一条嘴上的通路（方案 §二 ③→④→⑤）。本文件钉三层的口径：
//  纯核（poolPickThesis / factor-pill-core）行为；装配（QuantPage/AiScanPage/LabTabs/chat-tools）形状。
// 诚实底线照旧：池序是排序不是推荐、可少选可不选、截断必须说明、离线不假装转交。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FACTOR_CATEGORIES } from "../../src/lib/quant/types.ts";
import {
  poolPickThesis, POOL_PICK_MAX_DEFAULT, POOL_THESIS_ROW_CAP, type ThesisRow,
} from "../../src/lib/quant/screener/pick-pool-core.ts";
import {
  FACTOR_CATEGORY_ZH, pillLabel, pillTitle, groupFactorsByCategory, type PillFactor,
} from "../../src/lib/quant/screener/factor-pill-core.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ---------------- 纯核：poolPickThesis（研究指令） ---------------- */

const rowsOf = (n: number): ThesisRow[] =>
  Array.from({ length: n }, (_, i) => ({
    symbol: `60000${i % 10}.SH`,
    name: `测试票${i + 1}`,
    close: 10 + i,
    changePct: i % 3 - 1,
  }));

test("指令先报池再报票：池号回显两处（文案 + candidate_pool 工具提示），最多 X 只/可少选可不选一字不少", () => {
  const t = poolPickThesis("2026-09-22-全A-001", rowsOf(3));
  assert.ok(t.includes("2026-09-22-全A-001"), "池号必须在");
  assert.equal((t.match(/2026-09-22-全A-001/g) ?? []).length, 2, "一次在指令文案、一次在工具调用提示——两处都得给，模型才不用猜");
  assert.ok(t.includes(`最多选出 ${POOL_PICK_MAX_DEFAULT} 只`));
  assert.ok(t.includes("可以少选或不选"), "「不许硬凑够数」是指令的一部分，不是建议");
  assert.ok(t.includes("candidate_pool"), "工具名要给到——有工具环的通道直接读池，没有的通道也有名单兜底");
  const t5 = poolPickThesis("p-1", rowsOf(2), 5);
  assert.ok(t5.includes("最多选出 5 只"), "maxPicks 是参数不是写死");
});

test("池序不是推荐说了两遍还不算多：冻结时排序 + 不要把页面原始排序当推荐结果", () => {
  const t = poolPickThesis("p-1", rowsOf(2));
  assert.ok(t.includes("按保存时的页面排序（那是排序不是推荐）"));
  assert.ok(t.includes("不要把页面原始排序当作推荐结果"));
  assert.ok(t.includes("自主决定评价维度与权重"), "维度自主——不给固定打分模板");
});

test("五段式收口：每只给出理由/入场/仓位/失效/风险，取不到的口径是「暂无数据」不是编", () => {
  const t = poolPickThesis("p-1", rowsOf(1));
  for (const seg of ["入选理由", "入场条件", "仓位节奏", "失效条件", "主要风险"]) {
    assert.ok(t.includes(seg), `五段缺「${seg}」`);
  }
  assert.ok(t.includes("取不到就写暂无数据，不许凭记忆编"), "工具环兜底纪律随指令同行");
});

test("名单内联且截断如实：超过 30 只截取前 30 并写明池内共几只，一条不冒充全部", () => {
  const t = poolPickThesis("p-1", rowsOf(POOL_THESIS_ROW_CAP + 5));
  assert.ok(t.includes("测试票30"), "前 30 只必须在名单里");
  assert.ok(!t.includes("测试票31"), "第 31 只不能混进来");
  assert.ok(t.includes(`截取前 ${POOL_THESIS_ROW_CAP} 只（池内共 ${POOL_THESIS_ROW_CAP + 5} 只）`), "截断必须自报");
  const noTrunc = poolPickThesis("p-1", rowsOf(POOL_THESIS_ROW_CAP));
  assert.ok(!noTrunc.includes("截取前"), "恰好到上限不算截断，不许虚报");
});

test("空池与缺字段不硬造：空池写（空池），close/涨跌缺了就不印，不留 NaN/undefined 字样", () => {
  const empty = poolPickThesis("p-1", []);
  assert.ok(empty.includes("（空池）"));
  assert.ok(!empty.includes("NaN") && !empty.includes("undefined"));
  const bare = poolPickThesis("p-1", [{ symbol: "600519.SH" }]);
  assert.ok(bare.includes("?(600519.SH)"), "无 name 显 ?，无价格不硬补 0");
  assert.ok(!bare.includes("0.0"), "缺读数不当 0 用");
});

/* ---------------- 纯核：factor-pill-core（中文化是换脸不是藏身份） ---------------- */

test("类目中文表与 quant/types 的 FACTOR_CATEGORIES 双向对账：九对九，谁也别偷偷多/少", () => {
  assert.deepEqual(Object.keys(FACTOR_CATEGORY_ZH).sort(), [...FACTOR_CATEGORIES].sort(),
    "DB 类目集与中文读法必须同源，漏一个类目=那组 pill 显示生英文");
  for (const c of FACTOR_CATEGORIES) {
    assert.ok(FACTOR_CATEGORY_ZH[c].length >= 2, `类目 ${c} 的中文读法不能是占位`);
    assert.ok(!/[A-Za-z]/.test(FACTOR_CATEGORY_ZH[c]) || c === "AI_Discovered", "除 AI 发现外不含生英文");
  }
});

test("pillLabel：中文名优先；name 缺失/等于 key/全空白一律回退 key，不硬翻译", () => {
  assert.equal(pillLabel({ factorKey: "div_c_ma_c_20", version: 1, name: "趋势强度MA20" }), "趋势强度MA20");
  assert.equal(pillLabel({ factorKey: "zsb_dealer", version: 1 }), "zsb_dealer", "旧条目没 name 就如实显 key");
  assert.equal(pillLabel({ factorKey: "zsb_dealer", version: 1, name: "zsb_dealer" }), "zsb_dealer", "name==key 不算中文名");
  assert.equal(pillLabel({ factorKey: "zsb_dealer", version: 1, name: "   " }), "zsb_dealer");
});

test("pillTitle：存储协议照旧可见（key@version），中文化不是藏身份；未知类目原样带出不编造", () => {
  assert.equal(pillTitle({ factorKey: "mom_5", version: 2, category: "Momentum" }), "mom_5@2 · 动量");
  assert.equal(pillTitle({ factorKey: "mom_5", version: 2 }), "mom_5@2");
  assert.equal(pillTitle({ factorKey: "mom_5", version: 2, category: "Weird_Cat" }), "mom_5@2 · Weird_Cat");
});

test("分组：已知类目按声明序、未知/空类目垫底成「未分类」，组内保持库序，一条不丢", () => {
  const fs: PillFactor[] = [
    { factorKey: "a", version: 1, category: "Trend" },
    { factorKey: "b", version: 1, category: "Weird_Cat" },
    { factorKey: "c", version: 1, category: "Price" },
    { factorKey: "d", version: 1 },
    { factorKey: "e", version: 1, category: "Trend" },
  ];
  const gs = groupFactorsByCategory(fs);
  assert.deepEqual(gs.map((g) => g.category), ["Price", "Trend", "Weird_Cat", ""],
    "Price 在 Trend 前是按 FACTOR_CATEGORY_ZH 声明序；未知与空垫底");
  assert.deepEqual(gs.map((g) => g.label), ["价格形态", "趋势", "Weird_Cat", "未分类"]);
  assert.equal(gs.reduce((n, g) => n + g.factors.length, 0), fs.length, "分组不丢条目");
  assert.deepEqual(gs[1].factors.map((f) => f.factorKey), ["a", "e"], "组内保持传入顺序=latestOnly 库序");
  assert.deepEqual(groupFactorsByCategory([]), []);
});

/* ---------------- 装配钉：QuantPage 门户收敛（一个 Tab 不删） ---------------- */

const quantPage = read("../../src/components/desk/QuantPage.tsx");

test("门户收敛是分组不是删除：默认页挂 AI 选股，原 8 个专业/系统 Tab 的 key 一个不少", () => {
  assert.ok(quantPage.includes('<Tabs defaultValue="portal"'), "默认落 AI 选股门户");
  assert.ok(quantPage.includes('value="portal"') && quantPage.includes("<AiScanPage />"),
    "门户直接挂选股页同一实现——一份实现两处挂载，不抄第二份");
  for (const key of ["selection", "backtest", "factors", "mining", "research", "experiments", "knowledge", "overview"]) {
    assert.ok(quantPage.includes(`key: "${key}"`), `原 Tab「${key}」被删了——方案明令不删`);
    assert.ok(quantPage.includes(`value="${key}"`), `「${key}」只剩按钮没有内容区`);
  }
  assert.ok(quantPage.includes("主入口") && quantPage.includes("专业工具") && quantPage.includes("系统"),
    "三组层级是收敛的全部动作");
});

/* ---------------- 装配钉：AiScanPage 存池交择优出口 ---------------- */

const aiScan = read("../../src/components/desk/pages/AiScanPage.tsx");

test("「存池并交 AI 择优」= freeze(true) 走同一条冻结链路，成功后把研究指令交给助手（pendingAsk 一次性交接）", () => {
  assert.ok(aiScan.includes("const freeze = async (forPick = false)"), "一条龙复用 freeze，不另写一条存池路径");
  assert.ok(aiScan.includes("askInAssistant(poolPickThesis(j.pool_id, rows))"),
    "池号+名单由纯核装配，页面不自己拼文案");
  assert.ok(aiScan.includes("onClick={() => void freeze(true)}"));
  assert.ok(aiScan.includes("onClick={() => void freeze()}"),
    "普通冻结按钮必须包箭头——直挂 onClick 会把 MouseEvent 当成 forPick，点「冻结」变「交择优」");
  assert.ok(aiScan.includes("池仅存本地") && aiScan.includes("未转交择优"),
    "离线时池落本地存档、如实说没转交——不假装进了对话");
});

/* ---------------- 装配钉：chat-tools candidate_pool（服务端直读，无新引擎） ---------------- */

const chatTools = read("../../src/lib/desk/chat-tools.ts");

test("candidate_pool 工具：不带 pool_id 不猜池（列最近 5 个）；带错池如实 missing；名单截断到 40 且自报", () => {
  assert.ok(chatTools.includes('name: "candidate_pool"'), "已注册进 TOOLS——模型看得见才算通路");
  assert.ok(chatTools.includes("未指定池号 pool_id"), "不猜池：拿错池等于择优选错素材");
  assert.ok(chatTools.includes("最近的候选池"), "拒绝的同时给素材：列最近几个池号");
  assert.ok(chatTools.includes("候选池不存在"), "错池号不静默返回空名单");
  assert.ok(chatTools.includes("const CAP = 40") && chatTools.includes("rows.slice(0, CAP)"));
  assert.ok(chatTools.includes("其余未读，别当成整池都看过"), "截断说明随数据同行");
  assert.ok(chatTools.includes("不是推荐结果") && chatTools.includes("择优纪律: PICK_DISCIPLINE"),
    "池序口径与五条纪律从纯核同源带入，页面/工具两处一个说法");
  assert.ok(chatTools.includes("未记录（旧池）"), "旧池没记数据源就说没说 0");
});

/* ---------------- 装配钉：LabTabs 两 Tab 共用 FactorPillGrid（协议不变） ---------------- */

const labTabs = read("../../src/components/desk/quant/LabTabs.tsx");

test("因子 pill 中文化只换脸：两 Tab 共用 FactorPillGrid，选择串协议 key@version(,1,1) 一个字没动", () => {
  assert.equal(labTabs.match(/<FactorPillGrid/g)?.length, 2, "选股+回测两处消费同一份渲染");
  assert.ok(labTabs.includes("`${f.factorKey}@${f.version},1,1`"), "回测选择串仍是 key@version,权重,方向");
  assert.ok(labTabs.includes("sel.replace(tag + \";\", \"\").replace(tag, \"\") : sel + tag + \";\""),
    "勾选/取消的拼接语义照旧——中文化不许顺手改选择行为");
  assert.ok(!labTabs.includes("{f.factorKey}@{f.version}</Badge>"), "旧的直印 factorKey pill 不能残留在渲染里");
});
