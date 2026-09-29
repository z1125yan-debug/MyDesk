// P60 · Serenity（白毛股神）落点② 回归测试（2026-09-29）。
//
// 这一轮把两个「后端早就有、只是没进技能表」的接口接了出来：
//   sector_constituents        —— 板块成分股（东财 boardCode，与 /api/market/sectors 同一份通路）
//   stock_business_composition —— 个股主营与产品构成（china-stock-mcp get_product_info + get_stock_basic_info）
//
// 分三类断言，各自对着一个具体的「容易说谎」的点：
//  1. 触发口径是纯函数（extractBoardCodes / wantsChain）——纯层只认形状，不替用户猜板块、不扩场景；
//  2. 两道条件闸（board_code / chain）真的接进了 planDispatch，且**没有**改动既有场景的调度逐字输出；
//  3. 服务层工具的形状（phase 必标、非法入参回 missing 而不是空数组、口径说明必须随数据一起给出）。
// chat-tools 是服务层（带 @/ 与 IO，Node 直跑解析不了别名），所以第 3 类读源码断言。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chainFollowUpCalls, classifyIntent, extractBoardCodes, wantsChain, planDispatch } from "../../src/lib/desk/intent-core.ts";
import { BUILTIN_SKILLS, SKILLS } from "../../src/lib/desk/skills-core.ts";
import { CHAIN_MODE_OVERRIDE, CHAIN_RESEARCH_SKELETON, MODE_NOTES, modeNoteFor } from "../../src/lib/desk/modes.ts";
import { constituentsOfIndustry, industryNames, industrySnapshotMeta } from "../../src/lib/quant/data/industry-constituents.ts";
import { chainOfSector, fundamentalsOfSector, sectorChainMeta } from "../../src/lib/quant/data/sector-chain.ts";
import { buildChainDigest } from "../../src/lib/desk/chain-digest-core.ts";

const toolsSrc = readFileSync(new URL("../../src/lib/desk/chat-tools.ts", import.meta.url), "utf8");
const sceneSrc = readFileSync(new URL("../../src/lib/desk/scene-dispatch.ts", import.meta.url), "utf8");
const followSrc = readFileSync(new URL("../../src/lib/desk/chain-followup.ts", import.meta.url), "utf8");

// ---------- ① 触发口径：纯函数，只认形状 ----------

test("extractBoardCodes：只认 BK 代码形状，大小写归一、去重，不做「板块名→代码」的反查", () => {
  assert.deepEqual(extractBoardCodes("BK0448 这个板块现在什么情况"), ["BK0448"]);
  assert.deepEqual(extractBoardCodes("bk0448 和 BK0483 都看看"), ["BK0448", "BK0483"]);
  assert.deepEqual(extractBoardCodes("BK0448 与 BK0448 是同一个"), ["BK0448"]);
  // 板块名不是代码：纯层猜名字就是把猜测当事实，这里必须抽不出来
  assert.deepEqual(extractBoardCodes("印制电路板这个板块怎么样"), []);
  assert.deepEqual(extractBoardCodes("688256 现价"), []);
  assert.deepEqual(extractBoardCodes(""), []);
});

test("wantsChain：只收确定指向链上关系的词，不收「受益 / 题材」这类过宽的词", () => {
  for (const q of [
    "AI 服务器产业链谁真受益",
    "这条供应链上还有谁",
    "往上走一层看设备环节",
    "卡点在哪",
    "国产替代到哪一步了",
    "谁卡脖子",
  ]) {
    assert.equal(wantsChain(q), true, `「${q}」应判成链研究`);
  }
  for (const q of [
    "688256 怎么看",
    "降息受益股有哪些",
    "半导体板块资金榜",
    "帮我选股",
  ]) {
    assert.equal(wantsChain(q), false, `「${q}」不该触发链研究闸`);
  }
  assert.equal(wantsChain(""), false);
});

// ---------- ② 调度：两道闸接上了，既有场景逐字未动 ----------

test("板块场景：提问里点了 BK 代码才预取成分股；没点代码照旧只有资金榜", () => {
  const withCode = planDispatch({ intent: classifyIntent({ question: "BK0448 板块资金流入多少" }) });
  assert.deepEqual(withCode.calls.map((c) => c.tool), ["sector_rank", "sector_constituents"], "点了代码就把真实成分股名单也送到模型面前");
  assert.deepEqual(withCode.calls[1].args, { code: "BK0448", kind: "industry" }, "板块代码与类型按提问口径给");
  assert.match(withCode.calls[1].reason, /成分股/);

  const noCode = planDispatch({ intent: classifyIntent({ question: "哪个行业资金流入最多" }) });
  assert.deepEqual(noCode.calls.map((c) => c.tool), ["sector_rank"], "没点代码就无从知道取哪个板块，不硬猜一个");
  assert.deepEqual(noCode.skipped, [], "没触发不是取数失败：不留 skipped、不画一个不存在的步骤");

  const concept = planDispatch({ intent: classifyIntent({ question: "BK0483 这个概念板块有哪些成分" }) });
  assert.equal(concept.calls.find((c) => c.tool === "sector_constituents")?.args.kind, "concept", "说了「概念」按概念取");
});

test("个股分析：产业链类问法才追取主营构成；普通问法仍是原来的六件套逐字不动", () => {
  const chain = planDispatch({
    intent: classifyIntent({ question: "688256 的技术面怎么看，它在产业链里处于什么环节" }),
  });
  assert.deepEqual(
    chain.calls.map((c) => c.tool),
    ["stock_snapshot", "stock_depth", "stock_trades", "stock_kline_summary", "stock_fund_flow", "stock_business_composition", "stock_news"],
    "链研究问法在六件套里追一条主营构成（per_symbol，逐只；注册顺序＝调度顺序，排在资金流之后、消息面之前）",
  );
  const biz = chain.calls.find((c) => c.tool === "stock_business_composition");
  assert.deepEqual(biz?.args, { symbol: "688256.SH" });
  assert.match(biz?.reason ?? "", /主营/);

  const plain = planDispatch({ intent: classifyIntent({ question: "688256 和 600519 怎么看" }) });
  assert.deepEqual(
    plain.calls.map((c) => c.tool),
    [
      "stock_snapshot", "stock_depth", "stock_trades", "stock_kline_summary", "stock_fund_flow", "stock_news",
      "stock_snapshot", "stock_depth", "stock_trades", "stock_kline_summary", "stock_fund_flow", "stock_news",
    ],
    "不是链研究的问法不该多打一次云 MCP：既有六件套逐字保住",
  );
});

test("两个新技能都不标 required：上游取不到留 missing，不触发补跑整轮", () => {
  assert.ok(!SKILLS.requiredToolsForScene("sector").has("sector_constituents"));
  assert.ok(!SKILLS.requiredToolsForScene("stock_analysis").has("stock_business_composition"));
  // 既有必读集一字不改
  assert.deepEqual([...SKILLS.requiredToolsForScene("sector")], ["sector_rank"]);
  assert.deepEqual(
    [...SKILLS.requiredToolsForScene("stock_analysis")].sort(),
    ["stock_fund_flow", "stock_kline_summary", "stock_news", "stock_snapshot"],
  );
});

test("技能表里两条都有 desc（注册口与界面都要能看出它是干什么的）", () => {
  for (const name of ["sector_constituents", "stock_business_composition"]) {
    const sk = BUILTIN_SKILLS.find((s) => s.name === name);
    assert.ok(sk, `${name} 在技能表里`);
    assert.ok((sk?.desc ?? "").length > 4, `${name} 的 desc 不能是空壳`);
  }
});

test("链研究闸不参与场景判定：classifyIntent 的结果不被新增词表改变", () => {
  // 为了取一份主营构成就把「AI 服务器产业链谁受益」掰成别的场景，是另一种说谎——
  // 触发口径只管取数（chain 闸），判场景仍只看 SCENE_RULES。
  const r = classifyIntent({ question: "AI 服务器产业链谁真受益" });
  assert.equal(r.scene, "general", "没命中场景词就还是通用问答，不为了取数硬掰场景");
  assert.equal(wantsChain("AI 服务器产业链谁真受益"), true, "但取数闸认得它");
});

// ---------- ③ 服务层工具形状（源码形状钉） ----------

test("两个工具都在 TOOLS 里、都标了 phase（P35 起内置工具一律显式标注）", () => {
  const block = toolsSrc.slice(toolsSrc.indexOf("export const TOOLS"), toolsSrc.indexOf("export const TOOL_NAMES"));
  for (const [name, phase] of [["sector_constituents", "local_data"], ["stock_business_composition", "external_data"]] as const) {
    const at = block.indexOf(`name: "${name}"`);
    assert.ok(at > 0, `${name} 必须登记进 TOOLS`);
    const seg = block.slice(at, block.indexOf('name: "', at + 10));
    assert.match(seg, new RegExp(`phase:\\s*"${phase}"`), `${name} 的 phase 应是 ${phase}`);
  }
  assert.match(toolsSrc, /async function toolSectorConstituents\(/, "要有执行本体");
  assert.match(toolsSrc, /async function toolStockBusinessComposition\(/, "要有执行本体");
});

test("取数纪律：非法板块码 / 接口报错 / 名单为空一律回 missing，且三种事实分开写", () => {
  assert.match(toolsSrc, /板块代码非法：/, "非法 BK 代码必须如实回 missing");
  // 「取数失败」与「名单确实为空」是两件事：把网络抖动写成「这个板块不存在」＝把一次抖动写成了事实
  assert.match(toolsSrc, /成分股取数失败：/, "接口报错要说成取数失败");
  assert.match(toolsSrc, /成分股名单为空/, "接口正常但名单为空要另说");
  assert.match(toolsSrc, /不代表这个板块没有成分股/, "报错话术里要明确不把抖动说成板块下架");
  assert.match(toolsSrc, /主营\/产品构成暂无数据/, "主营取不到必须回 missing，不许拿标签冒充");
});

test("数据真实性：主营构成的「不含收入占比」写进返回值，不让模型自行拆分比例", () => {
  // 上游 get_product_info 只给「卖什么」（主营业务/产品类型/产品名称），不给按产品的收入结构。
  // 这条口径必须在返回值里显式给出，否则模型会把「产品名称」当成「哪块赚多少」。
  assert.match(toolsSrc, /不含按产品的收入占比/);
  assert.match(toolsSrc, /不要自行拆分比例/);
});

test("板块榜必须带板块代码：否则「榜单 → 成分 → 主营」这条链根本走不通", () => {
  // 实测踩到：sector_rank 原来只报板块名，模型拿到榜单也没法调 sector_constituents（那边只认 BK 代码），
  // 于是链研究只能停在「暂无数据」。榜首行的 code 必须一起给出去。
  assert.match(toolsSrc, /板块代码:\s*\/\^BK\\d\+\$\/i\.test\(String\(r\.code \?\? ""\)\) \? r\.code : null/,
    "只放东财 BK 代码：同花顺兜底行的 THS 前缀会被模型抄进正文当板块名，下游又用不上，直接给 null");
  // 没有东财代码的行要说清原因，别让模型拿 THS881270 去调成分股接口
  assert.match(toolsSrc, /同花顺兜底行没有东财板块代码/, "口径必须写清楚为什么这一行没有代码");
});

// ---------- ④ 二阶段预取：链研究顺榜首板块自动追一层成分（纯核判定 + 服务层接线） ----------

const emRank = {
  数据源: "东财板块资金榜（主力净流入排序）",
  板块: [
    { 排名: 1, 板块代码: "BK0448", 名称: "元件", 涨跌幅: 4.42, 主力净额亿: 44.14, 领涨股: "迅捷兴" },
    { 排名: 2, 板块代码: "BK0475", 名称: "房地产开发", 涨跌幅: 1.1, 主力净额亿: 25.42, 领涨股: "特发服务" },
  ],
};
const thsRank = {
  数据源: "同花顺板块资金流榜（净额=流入−流出口径，非主力拆分口径）",
  板块: [
    { 排名: 1, 板块代码: "THS881270", 名称: "元件", 涨跌幅: 4.42, 主力净额亿: 44.14, 领涨股: "迅捷兴" },
    { 排名: 2, 板块代码: null, 名称: "房地产", 涨跌幅: 1.1, 主力净额亿: 25.42, 领涨股: "特发服务" },
  ],
};

test("chainFollowUpCalls：链研究问法 + 榜首带东财 BK 代码，才追一层成分股（只追榜首一个）", () => {
  const first = [{ tool: "sector_rank", out: emRank }];
  const call = chainFollowUpCalls(first, "AI 算力产业链现在哪一环最热");
  assert.equal(call.length, 1, "只追一层、只追一个板块");
  assert.equal(call[0].tool, "sector_constituents");
  assert.deepEqual(
    call[0].args,
    { code: "BK0448", name: "元件", kind: "industry", size: 30 },
    "取榜首那一个板块的成分（前 30 只），并把板块名一起带上——板块整体市值/链上位置/板块财务要按板块名查本地映射",
  );
  assert.match(call[0].reason, /成分股/);

  // 说了「概念」就按概念口径取（与 planDispatch 的 board_code 分支同一口径）
  assert.equal(chainFollowUpCalls(first, "这个概念产业链谁卡脖子")[0].args.kind, "concept");
});

test("chainFollowUpCalls 的三条不追口径：非链研究 / 用户已点代码 / 第一棒没有榜单", () => {
  const first = [{ tool: "sector_rank", out: emRank }];
  // 1) 普通「哪个板块最强」不需要成分名单，多取一次是浪费
  assert.deepEqual(chainFollowUpCalls(first, "哪个板块今天最强"), []);
  // 2) 用户自己点了 BK 代码：第一棒已把那个板块的成分取过，不再追榜首
  assert.deepEqual(chainFollowUpCalls(first, "BK0483 这条产业链上有谁"), []);
  // 3) 第一棒没跑 sector_rank（个股分析 / 通用场景）：无从追起，不硬造一个
  assert.deepEqual(chainFollowUpCalls([{ tool: "stock_snapshot", out: {} }], "这条产业链谁受益"), []);
});

test("chainFollowUpCalls：同花顺兜底行（服务层没递行业名事实）/ missing 形状都不产生调用，不画注定失败的步骤", () => {
  // 东财断源时榜单退同花顺（THS 前缀），东财 b:BKxxxx 成分接口不认。
  // 没递 knownIndustries＝纯层不查字典：宁可少一步，也不拿一个本地没有的板块名发一次注定失败的调用。
  assert.deepEqual(chainFollowUpCalls([{ tool: "sector_rank", out: thsRank }], "元件产业链上游是谁"), []);
  // 接口报错回 missing（没有板块数组）：当作没有榜首，不炸
  assert.deepEqual(chainFollowUpCalls([{ tool: "sector_rank", out: { missing: "行业板块资金榜暂无数据" } }], "某产业链卡点在哪"), []);
});

test("chainFollowUpCalls：东财断源时，行业名命中本地快照才追（走本地行业归属快照备胎）", () => {
  const first = [{ tool: "sector_rank", out: thsRank }];
  // 服务层把「本地行业归属快照认得哪些行业名」这个事实递进来：榜首「元件」认得 → 改带行业名追本地备胎
  const call = chainFollowUpCalls(first, "AI 算力产业链现在哪一环最热", ["元件", "半导体", "银行"]);
  assert.equal(call.length, 1, "只追一层、只追一个板块");
  assert.equal(call[0].tool, "sector_constituents");
  assert.deepEqual(call[0].args, { name: "元件", kind: "industry", size: 30 }, "带行业名走本地快照（本地只有行业板，kind 固定 industry）");
  assert.match(call[0].reason, /本地行业归属快照/, "说辞要写明这一棒的口径是本地快照，不是东财板块成分");

  // 榜首行业名本地不认得（例如榜单跑到概念板/名字对不上）→ 不追，不画注定失败的步骤
  assert.deepEqual(chainFollowUpCalls(first, "AI 算力产业链现在哪一环最热", ["半导体", "银行"]), []);
  // 东财行优先：榜首带 BK 代码时仍走东财真成分，不因为递了行业名就改口径
  const emFirst = [{ tool: "sector_rank", out: emRank }];
  assert.deepEqual(
    chainFollowUpCalls(emFirst, "AI 算力产业链现在哪一环最热", ["元件"])[0].args,
    { code: "BK0448", name: "元件", kind: "industry", size: 30 },
  );
});

const consOut = {
  数据源: "本地行业归属快照（非东财板块成分）",
  板块名: "元件",
  成分股数量: 45,
  成分股: [
    { 代码: "002384", 名称: "东山精密", 总市值亿: 3099.08, 档位: "龙头" },
    { 代码: "002916", 名称: "深南电路", 总市值亿: 2524.47, 档位: "龙头" },
    { 代码: "002463", 名称: "沪电股份", 总市值亿: 2255.35, 档位: "龙头" },
    { 代码: "300476", 名称: "胜宏科技", 总市值亿: 2112.69, 档位: "龙头" },
  ],
};

test("chainFollowUpCalls 第二棒：成分股到手后，对代表个股补 行情/技术/盘口/主营/消息", () => {
  const rounds = [
    { tool: "sector_rank", out: thsRank },
    { tool: "sector_constituents", out: consOut },
  ];
  const calls = chainFollowUpCalls(rounds, "AI 算力产业链上游卡点在哪", ["元件"]);
  assert.equal(calls.length, 15, "前 3 只代表个股 × 5 个工具（行情/技术/五档/主营/消息）");
  assert.deepEqual([...new Set(calls.map((c) => c.tool))].sort(), [
    "stock_business_composition", "stock_depth", "stock_kline_summary", "stock_news", "stock_snapshot",
  ].sort(), "补的是这五类——正是此前被写成「暂无数据」的那几类");
  assert.deepEqual(
    [...new Set(calls.map((c) => String((c.args as { symbol?: unknown }).symbol)))],
    ["002384.SZ", "002916.SZ", "002463.SZ"],
    "只补成分股里市值最大的前 3 只，且统一成带后缀的 symbol",
  );
  // 每个代表个股都凑齐五个工具（不是随机挑几个）
  for (const sym of ["002384.SZ", "002916.SZ", "002463.SZ"]) {
    assert.equal(calls.filter((c) => (c.args as { symbol?: unknown }).symbol === sym).length, 5, `${sym} 五件套齐`);
  }
  // 幂等：已经补过（raws 里有 stock_snapshot）就不再产生
  assert.deepEqual(chainFollowUpCalls([...rounds, { tool: "stock_snapshot", out: {} }], "AI 算力产业链上游卡点在哪", ["元件"]), []);
  // 第一棒没拿到成分名单（missing）→ 第二棒一个调用都不产生，不画注定失败的步骤
  assert.deepEqual(chainFollowUpCalls([
    { tool: "sector_rank", out: thsRank },
    { tool: "sector_constituents", out: { missing: "本地行业归属快照里没有「AI芯片」这个行业名" } },
  ], "AI 算力产业链上游卡点在哪", ["元件"]), []);
});

test("sector-chain：板块 → 产业链上/中/下游环节 + 板块财务分量（本地映射，查不到回 null）", () => {
  const chain = chainOfSector("元件");
  assert.ok(chain, "「元件」应有产业链映射（板块风险页用的同一份 sector-industry-map.json）");
  assert.equal(chain!.domain, "AI算力", "域要能看出来");
  const all = [...chain!.上游, ...chain!.中游, ...chain!.下游] as { 节点?: string; 节点ID?: string }[];
  assert.ok(all.some((n) => n.节点ID === "ai_pcb"), "元件映射到 AI算力 域的 PCB/CCL 节点");
  assert.equal(chainOfSector("不存在的板块名"), null, "查不到回 null，不拿相近板块硬凑");

  const fund = fundamentalsOfSector("元件");
  assert.ok(fund && typeof fund.earnings_yoy === "number", "板块财务分量要能给到利润同比");
  assert.match(String(fund!.口径), /非市值加权/, "口径要写明是按板块聚合、非市值加权");
  assert.equal(fundamentalsOfSector("不存在的板块名"), null);
  const meta = sectorChainMeta();
  assert.ok(meta.mappedSectorCount > 20, "映射表覆盖的板块数要如实给出");
});

test("industry-constituents：行业名精确命中本地快照，查不到回 null（不拿相近名硬凑）", () => {
  const names = industryNames();
  assert.ok(names.length > 50, `本地行业归属快照应有成规模的行业名（实得 ${names.length}）`);
  assert.deepEqual(names.slice(0, 3), ["电网设备", "游戏", "医疗器械"], "读的是 data/sector-constituents.json 的 industries 键集");
  const meta = industrySnapshotMeta();
  assert.ok(meta && meta.generatedAt, "快照元信息要能如实给出生成时点（返回值要带这个日期）");

  const hit = constituentsOfIndustry("半导体");
  assert.ok(hit && hit.count > 50, "「半导体」应命中本地成分（实得 " + (hit?.count ?? 0) + " 只）");
  // 市值降序：第一只应是快照里市值最大的（口径=本地快照，不是东财板块成分）
  assert.ok((hit!.members[0].mktCapYi ?? 0) >= (hit!.members[hit!.members.length - 1].mktCapYi ?? 0), "成分按总市值降序");
  assert.ok(["leader", "core", "second"].includes(String(hit!.members[0].tier)), "档位要能区分龙头/核心/二线");

  // 去后缀容错：带「板块/行业」后缀仍应命中同一个行业
  assert.equal(constituentsOfIndustry("半导体行业")?.count, hit!.count, "带「行业」后缀应命中同一个行业");
  // 不是本地行业名一律回 null：「AI芯片」是概念板，本地无源，绝不拿「半导体」近似硬凑
  assert.equal(constituentsOfIndustry("AI芯片"), null, "概念名不得硬凑到相近行业");
  assert.equal(constituentsOfIndustry("不存在的行业名"), null);
  assert.equal(constituentsOfIndustry(""), null);
});

test("服务层真的把补数棒接上了（不是只写了纯核没人调）+ 递进了行业名事实 + 两棒循环", () => {
  assert.match(sceneSrc, /planChainFollowUps\(raws, opts\.intent\.question\)/, "预取层要调事实注入层算出下一棒");
  // 事实注入层：读本地行业名快照递给纯核；判定仍只在 intent-core（本层不许写判定）
  assert.match(followSrc, /chainFollowUpCalls\(firstRound, question, industryNames\(\)\)/, "事实注入层要把本地行业名递进纯核");
  assert.match(followSrc, /industryNames\(\)/, "本地行业名快照由这一层读，scene-dispatch 不引量化取数层");
  assert.ok(!/classifyIntent\(|SCENE_RULES/.test(followSrc), "事实注入层不写判定");
  assert.match(sceneSrc, /sector_constituents: "取板块成分股真实名单"/, "第一棒要有人话步骤标签，不能只出现裸工具名");
  assert.match(sceneSrc, /stock_business_composition: "取主营与产品构成（披露原文）"/, "第二棒的补数工具也要有人话标签");
  assert.match(sceneSrc, /boardName \? `\$\{base\} · \$\{boardName\}` : base/, "带行业名的第一棒也要在时间线标出是哪个行业");
  // 两棒循环：跑完再问一次，纯核说没有了就停；步号接着编、四路合流
  assert.match(sceneSrc, /for \(let round = 0; round < 2; round\+\+\)/, "补数层要能连跑两棒（成分 → 代表个股）");
  assert.match(sceneSrc, /followSteps\.push\(\.\.\.r\.steps\)/, "第二棒的步骤/行/缺失/trace 要合流进同一轮");
  assert.match(sceneSrc, /followNotRun\.push\(\.\.\.r\.notRun\)/, "断开后没执行的补数调用也要留痕");
});

test("骨架：允许并鼓励具体动作建议、禁止把工具名/英文字段名写进正文", () => {
  const sk = CHAIN_RESEARCH_SKELETON;
  // 用户口径（2026-09-29）：「可以给买卖动作建议 这恰恰是我后期最需要做的」
  assert.match(sk, /动作建议要给，而且要具体/, "红线② 必须放开动作建议");
  assert.ok(!sk.includes("不给动作建议"), "旧口径（排序只说研究价值、不给动作建议）必须删掉");
  assert.match(sk, /【输出五段/, "输出结构要含「五、动作与观察条件」");
  assert.match(sk, /五、动作与观察条件/, "动作建议要有固定的落点段");
  // 用户口径：正文里不许出现 sector_rank 这类英文工具名
  assert.match(sk, /正文里不许出现工具名或英文字段名/, "红线③ 禁止暴露内部件");
  assert.match(sk, /不要写「可观察 sector_rank 主力净额变化」|sector_rank \/ stock_snapshot/, "要给出反例说明禁的是什么");
  // 能取到的不许再写「暂无数据」；只留真无源的硬缺口
  assert.match(sk, /不要把它们写成「暂无数据」/, "要列出本轮会自动补齐的数据");
  assert.match(sk, /真·硬缺口/, "硬缺口清单要单独标出来");
  for (const kw of ["板块整体市值", "五档盘口与委买卖比", "板块利润 / 订单 / 存货 / 资本开支同比"]) {
    assert.ok(sk.includes(kw), `骨架要点名本轮已能取到的：${kw}`);
  }
  // 2026-09-29 真机三连问暴露的两类编造，逐条钉住：
  assert.match(sk, /环节名只许照抄那个归属字段里的节点名/, "环节名必须来自「产业链归属」，不许拿新闻里的词另起（光模块/光芯片事故×3）");
  assert.match(sk, /两条数值红线/, "数值红线要单列");
  assert.match(sk, /不许写「板块回调至 165–170 元」这种把板块当成一只股票的价格/, "板块没有股价：不许给出「板块回调到 X 元」");
  assert.match(sk, /不许把别的场合的示例区间（如大盘的 3800–3820、成交额 1\.5–1\.8 万亿）搬到本板块/, "别的骨架的示例区间不许搬进来");
  assert.match(sk, /标「已披露事实」的数字必须能在本轮返回值里逐字找到/, "证据档次不许拔高（编造数标成已披露事实）");
  assert.match(sk, /层级里的具体环节名只许填本轮「产业链归属」给出的节点/, "分层地图的六格不许用热门词填满");
  assert.match(sk, /绝不许拿代表个股主营或新闻标题里的热门词/, "点名禁掉拿主营/标题词填环节名");
  assert.match(sk, /这四项一项都不许省/, "板块段四项（板块名/整体市值/产业链归属/板块财务）强制到齐");
});

test("链路档必须换掉模式骨架（叠层说不动→代码层不下发）：deep 的五类表与个股四段不许同时在场", () => {
  // 事故（2026-09-29 真机）：deep 模式问「AI算力产业链上游的卡点环节在哪」时，模型照抄 MODE_NOTES.deep
  // 的「🧠 先摆数据：五类分列」，把「技术：暂无板块技术指标 / 消息：暂无行业层面新闻」写进正文——
  // 尽管链骨架第 227 行已写「不要套那张五类表」。两条矛盾指令同时在场，模型选了更结构化、更靠前的那条。
  // 修法：命中链路档时整段不发 MODE_NOTES[mode]，改发 CHAIN_MODE_OVERRIDE。
  assert.match(CHAIN_MODE_OVERRIDE, /默认输出骨架，本轮整段不生效/, "替换件必须显式声明模式骨架作废");
  assert.match(CHAIN_MODE_OVERRIDE, /先摆数据/, "要指名道姓禁掉那张分类表");
  assert.match(CHAIN_MODE_OVERRIDE, /品种名|个股标题/, "要禁掉个股标题格式");
  assert.match(CHAIN_MODE_OVERRIDE, /大盘那套四段[\s\S]*?一个都不许搬进本轮/, "大盘骨架的示例区间也要禁（3800 点事故）");
  // 触发口径与预取层同源：modeNoteFor(mode, true) 必须不是 MODE_NOTES[mode]
  assert.equal(modeNoteFor("deep", true), CHAIN_MODE_OVERRIDE, "链路档必须换成替换件");
  for (const m of ["decision", "judge", "deep", "search"] as const) {
    assert.equal(modeNoteFor(m, false), MODE_NOTES[m], `非链路档照旧走 MODE_NOTES.${m}`);
  }
  // 两处接线：服务端必须在 systemPrompt 里用 modeNoteFor，且回显语料跟着实际下发的那份走
  const routeSrc = readFileSync(new URL("../../src/app/api/ai/chat/route.ts", import.meta.url), "utf8");
  assert.match(routeSrc, /const modeNote = modeNoteFor\(mode, chainResearch\)/, "systemPrompt 侧没接线");
  assert.match(routeSrc, /const chainResearch = wantsChain\(/, "链路档判定要与预取层同源（wantsChain）");
  assert.match(routeSrc, /systemPrompt\(mode, horizon, body\?\.focusSymbol, holdNote,[\s\S]*?chainResearch\)/, "chainResearch 要真传进 systemPrompt");
  assert.match(routeSrc, /const lastUserEcho = \[[\s\S]*?\bmodeNote\b/, "回显语料要换成实际下发的那份");
  assert.ok(!/const lastUserEcho = \[[\s\S]*?MODE_NOTES\[mode\]/.test(routeSrc), "语料里还留着被换掉的那份骨架");
  assert.match(routeSrc, /chainResearch \? "" : MARKET_OUTLOOK_SKELETON/, "大盘骨架在链路档也要整段不发（示例区间会污染链研究）");
  assert.match(CHAIN_RESEARCH_SKELETON, /整段替换掉/, "链骨架里要有一句指路，说明模式骨架已被替换");
});

test("落点 A 口径：本地成分行必须写明「非东财板块成分」与「不含实时行情」，不让模型当实时用", () => {
  // 本地快照的键名/口径字段是模型判断「这条数据能不能当今天的读数」的唯一依据，必须显式给出。
  assert.match(toolsSrc, /本地行业归属快照（非东财板块成分）/, "数据源要写明是本地快照、非东财板块成分");
  assert.match(toolsSrc, /不是同一口径/, "与东财 BK 板块成分不是同一口径这句话必须在返回值里");
  assert.match(toolsSrc, /涨跌幅快照日/, "快照的涨跌幅键名要带「快照日」，否则模型会当今天读");
  assert.match(toolsSrc, /不是今天/, "要明确写「不是今天」");
  assert.match(toolsSrc, /name:\s*\{\s*type:\s*"string"/, "TOOLS 登记要暴露 name 参数（模型能按行业名自取）");
  assert.match(toolsSrc, /async function toolSectorConstituents\(args: \{ code\?: string; name\?: string;/, "执行本体的入参要含 name");
});

test("板块级补数：整体市值 / 链上位置 / 板块财务三项都要给，且各自缺了不吞整块", () => {
  assert.match(toolsSrc, /板块整体市值亿/, "要合计板块整体市值（此前被写成「暂无数据」）");
  assert.match(toolsSrc, /链上位置/, "要给板块在产业链里的上/中/下游环节");
  assert.match(toolsSrc, /板块财务分量/, "要给板块利润/订单/存货/资本开支同比");
  assert.match(toolsSrc, /是映射表未收录，不是本轮没取/, "链上位置缺时要说清是「表未收录」而不是「没取」");
  assert.match(toolsSrc, /chainOfSector|fundamentalsOfSector/, "两个本地取数函数要真的接上");
  assert.match(toolsSrc, /各自独立缺失|留空，不拿别的数顶上/, "一个子项缺了不许把整块吞掉");
});

test("代表个股速览：把 15 份个股结果压成一只票一行，字段抄自各工具、缺就写缺", () => {
  const rounds = [
    { tool: "sector_rank", out: thsRank },
    { tool: "sector_constituents", out: consOut },
    {
      tool: "stock_snapshot",
      out: { symbol: "002384.SZ", 名称: "东山精密", 现价: 171.21, 涨跌幅: -9.03, 成交额亿: 5.78, 主力净额亿: 1.0, 市盈率TTM: 87.47, 行业: "元件" },
    },
    {
      tool: "stock_kline_summary",
      out: { symbol: "002384.SZ", 技术状态: { above_ma_5: 0, above_ma_20: 0, macd: -3.08, rsi_14: 40.5 } },
    },
    { tool: "stock_depth", out: { symbol: "002384.SZ", 委买卖比: 0.62, 委买总量手: 1234, 委卖总量手: 2000 } },
    { tool: "stock_business_composition", out: { symbol: "002384.SZ", 主营业务: "精密电子制造与服务" } },
    { tool: "stock_news", out: { symbol: "002384.SZ", 新闻: [{ 标题: "产业链公司加速扩产光通信", 时间: "2026-09-28" }], 公告: [{ 标题: "x" }] } },
  ];
  const d = buildChainDigest(rounds);
  assert.ok(d, "有代表个股快照就要产出速览");
  assert.match(d!, /^\[链研究速览（本轮已取到/);
  assert.match(d!, /002384\.SZ 东山精密/);
  assert.match(d!, /现价 171\.21（-9\.03%）/);
  assert.match(d!, /主力净额 1亿|主力净额 1 亿|主力净额 1{0,1}亿/, "行情字段照抄快照");
  assert.match(d!, /MA5 ✗/);
  assert.match(d!, /MACD -3\.08/);
  assert.match(d!, /委买卖比 0\.62/);
  assert.match(d!, /主营「精密电子制造与服务」/);
  assert.match(d!, /消息「产业链公司加速扩产光通信」（2026-09-28）/, "消息带标题与时间");
  assert.match(d!, /另有 1 条公告/);

  // 缺的维度写「缺」，不许拿别的字段顶上
  const partial = buildChainDigest([{ tool: "stock_snapshot", out: { symbol: "002384.SZ", 名称: "东山精密" } }]);
  assert.ok(partial);
  assert.match(partial!, /行情 缺|技术 缺/);
  // 没有个股级结果（只有板块榜）→ 不产出速览，不注入空块
  assert.equal(buildChainDigest([{ tool: "sector_rank", out: thsRank }]), null);
  assert.equal(buildChainDigest([]), null);

  // 服务层真的把它放在注入块最前面（紧挨着第一棒的前面）
  assert.match(sceneSrc, /buildChainDigest\(raws\)/);
  assert.match(sceneSrc, /chain_rep_digest/, "速览要作为一行注入（块头有人话标签）");
});

test("速览的板块段：资金榜 / 板块整体市值 / 产业链归属 / 板块财务四项必须与代表个股一样第一眼可见", () => {
  // 事故（2026-09-29 真机三连问）：22836.84 亿元确实进了注入块，但模型三份正文一次都没提——
  // 它埋在 15 份结果中段。用户点名的「板块整体市值 / 板块内 AI 相关子行业 / 板块财务」必须置顶。
  const full = {
    tool: "sector_constituents",
    out: {
      板块名: "元件",
      成分股数量: 45,
      板块整体市值亿: 22836.84,
      板块整体市值口径: "= 本轮成分股总市值之和（本地快照口径，45/45 只有市值）",
      链上位置: { domain: "AI算力", 上游: [], 中游: [{ 节点ID: "ai_pcb", 节点: "PCB/CCL", 所属域: "AI算力", 层级: "中游" }], 下游: [] },
      板块财务分量: { sampled: 8, total: 8, inventory_ratio_pct: 14.38, earnings_yoy: 100.4, orders_yoy: 142.4, inventory_yoy: 88.2, capex_yoy: null, earnings_period: "2026-06-30" },
    },
  };
  const d = buildChainDigest([{ tool: "sector_rank", out: thsRank }, full])!;
  assert.ok(d, "只给板块块（没有代表个股）也要产出速览，否则板块段永远置顶不了");
  assert.match(d, /【板块段】/);
  assert.match(d, /板块 元件/);
  assert.match(d, /同花顺资金榜第 1 名/, "资金榜读数要带名次并写清榜的口径");
  assert.match(d, /主力净额 44\.14亿/, "净额照抄榜单");
  assert.match(d, /板块涨跌幅 \+4\.42%/, "涨跌幅照抄榜单");
  assert.match(d, /板块整体市值 22836\.84 亿元/, "用户点名的板块整体市值必须在速览里");
  assert.match(d, /产业链归属：AI算力域 · 中游：PCB\/CCL/, "板块内 AI 相关子行业要给到节点与上/中/下游");
  assert.match(d, /板块财务（截至 2026-06-30）：利润同比 \+100\.4% · 订单同比 \+142\.4% · 存货同比 \+88\.2% · 存货占比 14\.38%/, "板块财务逐项照抄，capex 为 null 就不写这一项");
  assert.ok(!d.includes("资本开支同比"), "缺的那一项不许写 0 / 空值充数");

  // 只有板块榜（成分股那一块没回来）→ 仍然不注入空块
  assert.equal(buildChainDigest([{ tool: "sector_rank", out: thsRank }]), null);
});
