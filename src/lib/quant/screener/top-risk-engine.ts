// 板块顶部风险 / 回撤性质识别器引擎（v5 + v3 核心）
//
// 输入：data/sector-daily-snapshots.json（每日板块快照，含 breadth/结构性分解/RS代理/前期涨幅/Δ）
//       data/sector-industry-map.json（板块→产业链映射，多对多，结构化）
// 输出：每个板块的 四分数 + 三阶段状态 + 顶部类型(A/B/C/D) + 结构性分解 + 前期涨幅 + 确认窗口
//       + 产业链诊断 + 主要/反向证据 + 分色信号 + conclusion（规则生成，不调模型）。
//
// 设计要点（v5 §2 / §4 / §5）：
//  · 禁单分数输出 → 四分数并列（短期回撤风险 / 中期顶部风险 / 趋势破坏程度 / 产业周期健康度）。
//  · 回撤性质识别器区分「上涨趋势内回撤」vs「趋势顶部形成」，靠三阶段状态机 + 结构性分解 + 确认窗口。
//  · 产业链层当前无实数据（Phase2 回补）→ industryHealth=null、节点标「数据不足」、降权、不硬编。
//  · 顶部类型 C(基本面顶部)/D(宏观顶部) 需产业链/跨市场数据，当前只能给 A/B + 待确认标注（诚实边界）。
//
// ⚠️ 阈值均为「首版默认」，回测(Phase5)出结果前只是合理初值；集中在 TH 常量区，便于调参。

import fs from "node:fs";
import path from "node:path";

// ── 可调阈值（TH = thresholds）────────────────────────────────────
const TH = {
  // 趋势反转(③)：已跌破60日趋势 + 核心破坏 + RS为负 + 当日急跌/距高深
  reversalBelowMA60: -8, // distMA60 < 此值 = 明显低于60日趋势
  reversalDrop: -3, // 当日中位 <= 此值
  reversalDrawdown20: -12, // 距20日高点 <= 此值
  // 顶部形成中(②)：结构/RS/宽度任一恶化 + (低于趋势 或 当日明显跌)
  formingBelowMA60Soft: -3,
  formingDrop: -2,
  // 趋势内回撤(①)：单日跌但结构 intact 且仍在趋势上方
  pullbackDrop: -1.5,
  pullbackAboveMA: 0, // distMA60 >= 此值 = 仍在趋势上方
  // 四分数缩放
  shortDropFull: -12, // 当日 -12% → 短期风险满分(分量)
  shortBreadthFull: 50, // 上涨占比 0% → 满分(分量)
  shortRsFull: -6, // RS代理 -6 → 满分(分量)
  damageStructFull: 10, // 龙头比板块差 10% → 结构分量满分
  damageRsMomFull: -8, // RS 10日变动 -8 → 满分
  damageBreadthFull: 50, // 宽度20日均值-今日 > 50pp → 满分
  midPosFull: 30, // 前期60日涨幅 >= 30% → 位置分量满分（高位更危险）
  midNearHighFull: -12, // 距20日高点 <= -12% → 高位回撤分量满分
  // 顶部类型
  typeRunUp60: 20, // 前期60日涨幅 >= 此值 = 刚跑高（情绪顶部候选）
  typeDrop: -2,
  // 产业健康度（Phase2 路线①解锁，2026-09-29）
  industryPriceFull: 20, // 节点价格 6 月斜率 ±20% → 信号满刻度
  industryMinMonths: 7, // 至少 7 个月度点才能算 6 月斜率，缺读数不硬算
  // 行业财务分量满刻度（同比%，2026-09-29 MCP 三表聚合）
  finEarningsFull: 30, // 利润同比 ±30% → 满刻度
  finOrdersFull: 30, // 合同负债(订单)同比 ±30%
  finInventoryFull: 30, // 存货同比（累库=负贡献）
  finCapexFull: 40, // 资本开支同比 ±40%
  // 行业财务分量权重（价格 40 / 利润 35 / 订单 15 / 存货 5 / 资本开支 5，缺的分量权重摊给其余）
  finWeights: { price: 40, earnings: 35, orders: 15, inventory: 5, capex: 5 },
  // 下行延续(④)：长期下行趋势中的破位/恶化 = 下行本身，不算顶部（2026-09-29 用户定案：
  // 「前面跌了好几个月、回温一点点，不算顶部」——顶部形态要求前期有上涨可反转）
  downtrendRun60: -10, // 前期60日累计涨幅 <= 此值 = 处长期下行趋势
} as const;

// ── 类型（服务端/客户端共用，见 top-risk-types.ts）─────────────────
import type { Stage, TopType, Tone, SectorTopRisk, SectorRow, ScannerResult } from "./top-risk-types";

// ── 数据加载（模块级缓存）─────────────────────────────────────────
interface ArchiveJson {
  days: Record<string, { tradeDate: string; industries: any[] }>;
}
interface IndustryMapJson {
  industryNodes: Record<string, { name: string; layer: string; domain: string }>;
  sectorIndustryMap: Record<string, { nodeId: string; role: string }[]>;
  metricSnapshots: Record<string, any[]>;
}

let _archive: ArchiveJson | null = null;
let _map: IndustryMapJson | null = null;

function loadArchive(): ArchiveJson {
  if (_archive) return _archive;
  const p = path.resolve(process.cwd(), "data", "sector-daily-snapshots.json");
  const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as ArchiveJson;
  _archive = parsed;
  return parsed;
}
function loadMap(): IndustryMapJson {
  if (_map) return _map;
  const p = path.resolve(process.cwd(), "data", "sector-industry-map.json");
  const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as IndustryMapJson;
  _map = parsed;
  return parsed;
}
interface FundamentalsJson { generatedAt: string; sectors: Record<string, SectorFundamentals> }
let _fundamentals: FundamentalsJson | null = null;
let _fundamentalsMtime = 0;
function loadFundamentals(): FundamentalsJson {
  const p = path.resolve(process.cwd(), "data", "sector-fundamentals.json");
  try {
    const mtime = fs.statSync(p).mtimeMs; // 财务快照按季度刷新：文件一变自动重载，不用重启 dev
    if (_fundamentals && _fundamentalsMtime === mtime) return _fundamentals;
    _fundamentals = JSON.parse(fs.readFileSync(p, "utf8")) as FundamentalsJson;
    _fundamentalsMtime = mtime;
  } catch {
    _fundamentals = { generatedAt: "", sectors: {} }; // 文件未生成（MCP 聚合没跑过）→ 全部板块无财务分量，不硬编
  }
  return _fundamentals;
}

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const r1 = (x: number | null) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);

// 取最新交易日 + 该日所有行业
function latestDay(asOf?: string) {
  const a = loadArchive();
  const dates = Object.keys(a.days).sort();
  const d = asOf && a.days[asOf] ? asOf : dates[dates.length - 1];
  return { date: d, industries: a.days[d].industries as any[] };
}

// 某行业的逐日序列（按日期排序），供 RS 持续性 / 宽度趋势计算
function seriesOf(sector: string): { date: string; mc: number; rs: number; adv: number; leader: number }[] {
  const a = loadArchive();
  const out: { date: string; mc: number; rs: number; adv: number; leader: number }[] = [];
  for (const [date, day] of Object.entries(a.days)) {
    const ind = (day.industries as any[]).find((x) => x.name === sector);
    if (ind) out.push({ date, mc: ind.medianChange, rs: ind.rsProxy, adv: ind.advPct, leader: ind.leaderChange });
  }
  out.sort((x, y) => (x.date < y.date ? -1 : 1));
  return out;
}

// ── 主计算 ────────────────────────────────────────────────────────
export function analyzeSector(sector: string, asOf?: string): SectorTopRisk | null {
  const { date, industries } = latestDay(asOf);
  const cur = industries.find((x) => x.name === sector);
  if (!cur) return null;
  const map = loadMap();
  const fundamentals = loadFundamentals().sectors[sector] ?? null;

  const mc: number = cur.medianChange ?? 0;
  const rs: number = cur.rsProxy ?? 0;
  const adv: number = cur.advPct ?? 0;
  const leader: number = cur.leaderChange ?? 0;
  const core: number = cur.coreChange ?? 0;
  const second: number = cur.secondChange ?? 0;
  const leadDec: number | null = cur.leadersDecliningPct ?? null;

  // RS 持续性 / 宽度趋势（从序列，按 asOf 对齐索引以便历史重放）
  const ser = seriesOf(sector);
  const idx = asOf ? ser.findIndex((s) => s.date === asOf) : ser.length - 1;
  const i = idx >= 0 ? idx : ser.length - 1;
  const rs10ago = i >= 10 ? ser[i - 10].rs : null;
  const rsMom10 = rs10ago != null && ser[i].rs != null ? ser[i].rs - rs10ago : null;
  const advWindow = ser.slice(Math.max(0, i - 19), i + 1).map((s) => s.adv).filter((v) => v != null) as number[];
  const advMean20 = advWindow.length ? advWindow.reduce((a, b) => a + b, 0) / advWindow.length : null;
  const breadthDeter = advMean20 != null ? advMean20 - adv : null;

  const coreBreak = leader < mc; // 龙头跌幅 > 板块跌幅 = 核心资产趋势破坏
  const longDowntrend = (cur.prevChange60 ?? 0) <= TH.downtrendRun60; // 长期下行中：破位≠顶部
  const belowTrend = (cur.distMA60 ?? 0) < TH.reversalBelowMA60;
  const belowTrendSoft = (cur.distMA60 ?? 99) < TH.formingBelowMA60Soft;
  const rsNeg = rs < 0;
  const rsVeryNeg = rs <= -2;
  const breadthPoor = adv < 40;

  // ── 四分数 ──
  const shortPullback = r1(
    clamp(
      (clamp(-mc / -TH.shortDropFull, 0, 1) * 45) +
        (clamp((50 - adv) / TH.shortBreadthFull, 0, 1) * 30) +
        (clamp(-rs / -TH.shortRsFull, 0, 1) * 25),
    ),
  );
  const structComp = clamp((mc - leader) / -TH.damageStructFull, 0, 1) * 40; // 龙头比板块差 → 结构破坏
  const rsMomComp = rsMom10 != null ? clamp(-rsMom10 / -TH.damageRsMomFull, 0, 1) * 30 : 15;
  const brdComp = breadthDeter != null ? clamp(breadthDeter / TH.damageBreadthFull, 0, 1) * 30 : 10;
  const trendDamageRaw = clamp(structComp + rsMomComp + brdComp);
  const trendDamage = r1(trendDamageRaw);

  const posComp = clamp((cur.prevChange60 ?? 0) / TH.midPosFull, 0, 1) * 30;
  const nearHighComp = clamp((cur.distFromHigh20 ?? 0) / -TH.midNearHighFull, 0, 1) * 20;
  const midTop = r1(
    clamp(posComp * 0.4 + nearHighComp * 0.3 + trendDamageRaw * 0.35 + (rsMom10 != null ? clamp(-rsMom10 / -TH.damageRsMomFull, 0, 1) * 15 : 0)),
  );

  // ── 阶段状态机（v2 形态修正：长期下行趋势中的破位=下行延续，不算顶部；回测校准：顶部形成中 = 跌破60日趋势+任一恶化信号，或 核心破坏+RS深负+下跌日）──
  const deterioration = (coreBreak ? 1 : 0) + (rsVeryNeg ? 1 : 0) + (breadthPoor ? 1 : 0);
  let stage: Stage;
  if (belowTrend && coreBreak && rsNeg && (mc <= TH.reversalDrop || (cur.distFromHigh20 ?? 0) <= TH.reversalDrawdown20)) {
    stage = longDowntrend ? "下行延续" : "趋势反转";
  } else if ((belowTrend && deterioration >= 1) || (coreBreak && rsVeryNeg && mc <= TH.formingDrop)) {
    stage = longDowntrend ? "下行延续" : "顶部形成中";
  } else if (mc <= TH.pullbackDrop && !coreBreak && (cur.distMA60 ?? 0) >= TH.pullbackAboveMA) {
    stage = "趋势内回撤";
  } else {
    stage = "趋势健康";
  }
  const stageTone: Tone =
    stage === "趋势反转" ? "red" : stage === "顶部形成中" ? "amber" : stage === "下行延续" ? "orange" : stage === "趋势内回撤" ? "blue" : "green";

  // ── 顶部类型（与阶段机对齐：B 类只在阶段已进入顶部状态时判；长期下行中不判 A/B——先回升积累涨幅、再破位才构成顶部形态）──
  const topStage = stage === "趋势反转" || stage === "顶部形成中";
  // C 类（基本面顶部）判定句：有行业财务就用真实同比说结论，没有才说"数据不足"
  const finEyN = fundamentals?.earnings_yoy ?? null;
  const finOyN = fundamentals?.orders_yoy ?? null;
  const cClassNote =
    finEyN != null
      ? `行业财务：利润同比${finEyN >= 0 ? "+" : ""}${r1(finEyN)}%${finOyN != null ? `、订单(合同负债)同比${finOyN >= 0 ? "+" : ""}${r1(finOyN)}%` : ""}——基本面${finEyN >= 10 ? "尚未恶化，C 类暂不成立" : finEyN <= -10 ? "已确认走弱" : "变化有限"}。`
      : "产业层数据不足，若订单↓/库存↑/利润↓确认恶化→升为 C 基本面顶部。";
  let topType: TopType = null;
  let topTypeLabel = "无明显顶部特征";
  let topTypeNote = "未触发 A/B 顶部信号。";
  if (longDowntrend) {
    topTypeNote = `处长期下行趋势（60日累计 ${r1(cur.prevChange60)}%），当前破位属下行延续，不判顶部；若先回升积累涨幅后再破位，才构成顶部形态。`;
  } else if (topStage && belowTrend && coreBreak && rsNeg) {
    // C 类升级路径（此前写死无法触发）：B 类技术形态 + 行业利润同比确认恶化（≤-10%）→ 基本面顶部
    topType = finEyN != null && finEyN <= -10 ? "C" : "B";
    topTypeLabel = topType === "C" ? "基本面顶部·盈利下滑" : "趋势顶部·深度调整";
    topTypeNote = `价格↓、RS↓、宽度↓、龙头破位；属上涨趋势中的深度调整/估值消化。${cClassNote}`;
  } else if (topStage && coreBreak) {
    topType = finEyN != null && finEyN <= -10 ? "C" : "B";
    topTypeLabel = topType === "C" ? "基本面顶部·盈利下滑" : "趋势顶部·深度调整";
    topTypeNote = `核心资产弱于板块（龙头跌幅>板块）。${cClassNote}`;
  } else if ((cur.prevChange60 ?? 0) >= TH.typeRunUp60 && mc <= TH.typeDrop) {
    topType = "A";
    topTypeLabel = "情绪顶部·涨多回调";
    topTypeNote = "前期涨幅大+短线急跌但核心未破，属情绪/拥挤回调，非产业周期结束。";
  } else if (topStage && mc <= TH.typeDrop && rsNeg) {
    topType = "B";
    topTypeLabel = "趋势顶部·深度调整";
    topTypeNote = `短线破位+相对全市场走弱。${cClassNote}`;
  }
  topTypeNote += " D 宏观顶部需跨市场层(A50/VIX/全球)数据，当前未接入。";

  // ── 信号分色板 ──
  const signals: { name: string; tone: Tone }[] = [
    { name: "价格动量", tone: mc <= TH.formingDrop ? "red" : mc <= 0 ? "amber" : "green" },
    { name: "板块宽度", tone: adv < 30 ? "red" : adv < 45 ? "amber" : "green" },
    { name: "相对全市场", tone: rs <= -2 ? "red" : rs < 0 ? "amber" : "green" },
    { name: "结构性", tone: coreBreak ? "red" : "green" },
    { name: "趋势位置", tone: (cur.distMA60 ?? 0) < TH.reversalBelowMA60 ? "red" : (cur.distMA60 ?? 0) < 0 ? "amber" : "green" },
  ];

  // ── 谁在跌（结构性分解）──
  const whoDrops = [
    { label: "龙头", v: r1(leader) },
    { label: "核心", v: r1(core) },
    { label: "二线", v: r1(second) },
  ];

  // ── 确认窗口 ──
  const window =
    stage === "趋势反转"
      ? "已破位，趋势破坏（观察 10–20 日是否持续）"
      : stage === "顶部形成中"
        ? "观察 3–5 日：能否收复跌幅 / RS 止跌 / 宽度回稳"
        : stage === "下行延续"
          ? "下行趋势延续中；观察 5–10 日能否止跌企稳（RS 转正 / 宽度回稳），企稳前不按顶部抄底逻辑看"
          : stage === "趋势内回撤"
            ? "观察 3–5 日：收复中则回到趋势内"
            : "—";

  // ── 产业链诊断（v5 第⑤层）──
  const links = map.sectorIndustryMap?.[sector] || [];
  const nodes: Record<string, { n: string; tone: Tone }[]> = { 上游: [], 中游: [], 下游: [] };
  let metricsAvailable = 0;
  for (const l of links) {
    const node = map.industryNodes?.[l.nodeId];
    if (!node) continue;
    nodes[node.layer] = nodes[node.layer] || [];
    const snap = map.metricSnapshots?.[l.nodeId];
    if (snap && snap.length) metricsAvailable++;
    nodes[node.layer].push({ n: node.name, tone: snap && snap.length ? "green" : "amber" });
  }
  const chainAvailable = links.length > 0;
  const industryHealthScore = computeIndustryHealth(links, map.metricSnapshots ?? {}, asOf, fundamentals);
  const finAvail = ["earnings", "orders", "inventory", "capex"].filter((k) => typeof fundamentals?.[`${k}_yoy`] === "number").length;
  const industryChain = {
    matched: chainAvailable ? `产业链映射 · ${links.length} 节点` : finAvail > 0 ? "未建商品链映射 · 财务快照已接入" : "未建商品链映射",
    available: chainAvailable && metricsAvailable > 0,
    nodes,
    metricsAvailable,
    financial: fundamentals
      ? {
          earnings_yoy: fundamentals.earnings_yoy ?? null,
          orders_yoy: fundamentals.orders_yoy ?? null,
          inventory_yoy: fundamentals.inventory_yoy ?? null,
          capex_yoy: fundamentals.capex_yoy ?? null,
          period: [fundamentals.earnings_period, fundamentals.orders_period, fundamentals.inventory_period, fundamentals.capex_period].filter(Boolean).sort().slice(-1)[0] ?? null,
          sampled: fundamentals.sampled ?? null,
          total: fundamentals.total ?? null,
          reading: readFundamentals(fundamentals),
        }
      : null,
    note: chainAvailable
      ? metricsAvailable > 0
        ? finAvail > 0
          ? "" // 财务解读正文已把数据来源讲清，不再重复
          : "产业链节点的价格，来自对应商品期货的真实月均价；行业财务快照待聚合脚本回补。"
        : "这个板块的产业链环节没有对应的商品期货可对照，节点价格暂缺。"
      : finAvail > 0
        ? "" // 未建映射但财务已接入：matched 标签已说明，不重复
        : "这个板块暂未建产业链映射，财务聚合也没有可用样本，产业层不参与打分。",
  };

  // ── 证据（财务分量按数据说话：有真实财报就给判断，不给模糊的"数据不足"）──
  const pro: string[] = [];
  const counter: string[] = [];
  const fin = fundamentals;
  const finEy = fin?.earnings_yoy ?? null;
  const finOy = fin?.orders_yoy ?? null;
  const finIy = fin?.inventory_yoy ?? null;
  if ((cur.prevChange60 ?? 0) >= 20) pro.push("前期涨幅较大(60日)");
  if (mc <= -3) pro.push("短线跌幅异常");
  if (coreBreak) pro.push("龙头弱于板块(核心破坏)");
  if (rsVeryNeg) pro.push("相对全市场持续走弱");
  if (breadthPoor) pro.push("板块宽度恶化");
  if ((cur.distFromHigh20 ?? 0) <= -12) pro.push("距近期高点回撤较深");
  if (finEy != null && finEy <= -10) pro.push(`行业利润同比下滑(${finEy}%)`);
  if (finOy != null && finOy <= -20) pro.push(`订单萎缩(合同负债同比 ${finOy}%)`);
  if (finIy != null && finIy >= 30 && (finOy == null || finOy <= 0)) pro.push("存货高企而订单走弱(累库)");
  if (!coreBreak) counter.push("龙头未破(核心资产抗跌)");
  if (adv >= 45) counter.push("宽度未崩");
  if ((cur.distMA60 ?? 0) >= 0) counter.push("仍在60日趋势线上方");
  if (rsMom10 != null && rsMom10 > 0) counter.push("相对全市场开始转强(10日动量转正)");
  if (advMean20 != null && adv > advMean20 + 5) counter.push("上涨家数较20日均值回暖");
  if (finEy != null && finEy >= 10) counter.push(`行业利润仍在增长(同比+${finEy}%)，基本面未见恶化`);
  if (finOy != null && finOy >= 20) counter.push(`订单高增(合同负债同比+${finOy}%)，需求不弱`);
  // 只有财务和价格全都拿不到时，才允许说"数据不足"——有数据就说判断
  if (finAvail === 0 && metricsAvailable === 0) counter.push("产业层数据不足(无法确认基本面恶化)");

  // ── 风险变化 Δ（vs 上一交易日）──
  const dMc = cur.delta?.medianChange ?? null;
  let dTone: SectorTopRisk["delta"]["tone"] = "flat";
  if (dMc != null) {
    if (dMc <= -3) dTone = "up_up";
    else if (dMc <= -1) dTone = "up";
    else if (dMc >= 3) dTone = "down_down";
    else if (dMc >= 1) dTone = "down";
  }
  const delta = { tone: dTone, medianChange: r1(dMc), label: dTone === "up_up" ? "升温" : dTone === "up" ? "升温" : dTone === "down" ? "缓解" : dTone === "down_down" ? "缓解" : "持平" };
  if (dMc != null && dMc >= 1) counter.push("较昨日跌幅收窄");

  // ── conclusion（规则生成，不调模型）──
  const conclusion = buildConclusion(sector, stage, topTypeLabel, mc, leader, core, second, rs, cur, pro, counter, industryChain.note);

  return {
    sector,
    stage,
    stageTone,
    scores: { shortPullback: shortPullback ?? 0, midTop: midTop ?? 0, trendDamage: trendDamage ?? 0, industryHealth: industryHealthScore },
    topType,
    topTypeLabel,
    topTypeNote,
    structural: { leader: r1(leader), core: r1(core), second: r1(second), leadersDecliningPct: r1(leadDec), coreBreak },
    position: {
      prevChange5: r1(cur.prevChange5 ?? null),
      prevChange20: r1(cur.prevChange20 ?? null),
      prevChange60: r1(cur.prevChange60 ?? null),
      prevChange120: r1(cur.prevChange120 ?? null),
      distFromHigh20: r1(cur.distFromHigh20 ?? null),
      distMA60: r1(cur.distMA60 ?? null),
    },
    signals,
    whoDrops,
    window,
    industryChain,
    pro,
    counter,
    conclusion,
    delta,
    advPct: r1(adv),
    medianChange: r1(mc),
    rsProxy: r1(rs),
    rawDate: date,
  };
}

function buildConclusion(
  sector: string,
  stage: Stage,
  topTypeLabel: string,
  mc: number,
  leader: number,
  core: number,
  second: number,
  rs: number,
  cur: any,
  pro: string[],
  counter: string[],
  chainNote: string,
): string {
  const mcS = r1(mc);
  const leadS = r1(leader);
  // 第一句：按阶段直接给判断（用户 2026-09-29 范式）
  const opening =
    stage === "趋势反转"
      ? "顶部信号已确认，趋势正在破坏。"
      : stage === "顶部形成中"
        ? "已出现顶部苗头，进入观察确认期。"
        : stage === "下行延续"
          ? "当前没有顶部信号——板块处在长期下行趋势里，下跌属于趋势本身的延续。"
          : stage === "趋势内回撤"
            ? "暂时没有顶部信号，这属于上升趋势中的正常回调。"
            : "当前尚未出现明确的顶部确认信号。";
  // 今日白话描述
  const dirWord = mc <= 0 ? `下跌${r1(-mc)}%` : `上涨${r1(mc)}%`;
  const leadPhrase =
    leader < mc
      ? `龙头跌得更狠（${leadS}% 对板块${mcS}%），核心资产转弱`
      : `龙头（${leadS}%）相对板块表现略强，核心资产尚未破位`;
  const rsPhrase =
    rs < 0
      ? `但板块相对全市场持续走弱（20日${r1(cur.prevChange20)}% / 60日${r1(cur.prevChange60)}% / 距MA60 ${r1(cur.distMA60)}%）`
      : `相对全市场也占优（20日${r1(cur.prevChange20)}% / 60日${r1(cur.prevChange60)}% / 距MA60 ${r1(cur.distMA60)}%）`;
  const body = `${sector}今日${dirWord}，板块短线${mc <= -3 ? "明显偏弱" : mc <= 0 ? "走势偏弱" : "表现活跃"}；${leadPhrase}。${rsPhrase}。`;
  const risks = `主要风险：${pro.slice(0, 3).join("、") || "无明显"}。`;
  const counters = `反向信号：${counter.slice(0, 2).join("；") || "暂无——各路读数同向走弱，没有像样的反向证据"}。`;
  // 综合判断：按阶段给收尾
  const verdict =
    stage === "趋势反转"
      ? "顶部信号已触发，需要重点跟踪后续走势。"
      : stage === "顶部形成中"
        ? "风险信号在积累，观察 3–5 日能否收复。"
        : stage === "下行延续"
          ? "技术面偏弱来自长期下行趋势本身，不构成新的顶部预警；重点看能否止跌企稳。"
          : stage === "趋势内回撤"
            ? "属正常回调范围，观察 3–5 日能否收复跌幅。"
            : pro.length
              ? "当前风险信号存在，但尚未形成需要升级警示的组合信号。"
              : "各路读数平稳，暂无需特别关注。";
  const finDisclaimer = counter.includes("产业层数据不足(无法确认基本面恶化)")
    ? "另外，这个板块的产业层数据还没接通，基本面变化暂时无法确认。"
    : "";
  return `${opening}${body}${finDisclaimer}${risks}${counters}综合判断：${verdict}`;
}

// ── 行业财务快照的人话解读 v2（用户 2026-09-29 给了完整范式：标题句 + 正文段落）──
// 范式要点：①标题直接说结论（"利润翻倍，订单增长超140%，企业提前备货"）；②正文交代
// 截止日期/样本/三个数字；③点出"订单增速高于利润增速=手里有未来业务"；④诚实标注
// "订单增长≠利润一定增长"、库存积压风险；⑤资本开支缺失要说明"无法判断是否在扩产"。
export interface FundamentalsReading {
  headline: string;
  body: string;
  /** 怎么看：三个数字各自的含义 */
  look: string;
  /** 需要注意：订单≠利润、库存双刃剑、资本开支缺失说明 */
  caution: string;
}

const signed = (v: number): string => `${v >= 0 ? "+" : ""}${r1(v)}%`;

function earningsWord(e: number): string {
  if (e >= 100) return "利润翻倍";
  if (e >= 30) return `利润大增(${signed(e)})`;
  if (e >= 10) return `利润稳增(${signed(e)})`;
  if (e > -10) return "利润基本持平";
  if (e > -30) return `利润下滑(${signed(e)})`;
  return `利润大幅恶化(${signed(e)})`;
}
function ordersWord(o: number): string {
  if (o >= 100) return "合同负债增长超一倍";
  if (o >= 50) return `合同负债增长超五成(${signed(o)})`;
  if (o >= 20) return `合同负债增长较快(${signed(o)})`;
  if (o >= 0) return "合同负债平稳";
  if (o > -30) return `合同负债萎缩(${signed(o)})`;
  return `合同负债大幅萎缩(${signed(o)})`;
}
function inventoryWord(inv: number, o: number | null): string {
  if (o != null && inv - o > 30) return "库存明显积压";
  if (o != null && o >= inv && o >= 20) return "企业提前备货";
  if (inv >= 0) return "存货温和增加";
  return "库存在去化";
}

export function readFundamentals(fin: {
  earnings_yoy?: number | null;
  orders_yoy?: number | null;
  inventory_yoy?: number | null;
  capex_yoy?: number | null;
  period?: string | null;
  earnings_period?: string | null;
  orders_period?: string | null;
  inventory_period?: string | null;
  capex_period?: string | null;
  sampled?: number | null;
  total?: number | null;
}): FundamentalsReading | null {
  const e = fin.earnings_yoy ?? null;
  const o = fin.orders_yoy ?? null;
  const inv = fin.inventory_yoy ?? null;
  const capex = fin.capex_yoy ?? null;
  if (e == null && o == null && inv == null && capex == null) return null;
  const period = fin.period ?? [fin.earnings_period, fin.orders_period, fin.inventory_period, fin.capex_period].filter(Boolean).sort().slice(-1)[0] ?? null;

  const words: string[] = [];
  if (e != null) words.push(earningsWord(e));
  if (o != null) words.push(ordersWord(o));
  if (inv != null && o != null) words.push(inventoryWord(inv, o));
  else if (inv != null) words.push(inv >= 0 ? "库存同步增加" : "库存在去化");
  const headline = `头部${fin.sampled ?? "?"}家公司${words.join("，")}`;

  // 正文：只报数字与总体状态
  const strength = (e != null && e >= 10) || (o != null && o >= 20) ? "整体盈利明显改善" : (e != null && e <= -10) || (o != null && o <= -30) ? "整体承压" : "表现平稳";
  const nums: string[] = [];
  if (e != null) nums.push(`利润同比增长${r1(e)}%`);
  if (o != null) nums.push(`合同负债增长${r1(o)}%`);
  if (inv != null) nums.push(`存货增长${r1(inv)}%`);
  const body = `截至${period ?? "最新报告期"}，市值排名前${fin.sampled ?? 8}的行业龙头${strength}：${nums.join("，")}。`;

  // 怎么看：三个数字各自的含义
  const lookParts: string[] = [];
  if (e != null) {
    if (e >= 10) lookParts.push(`利润同比增长${r1(e)}%，说明当前盈利能力明显改善`);
    else if (e > -10) lookParts.push(`利润基本持平（${r1(e)}%），盈利没有明显变化`);
    else lookParts.push(`利润同比${r1(e)}%，盈利在恶化`);
  }
  if (o != null && e != null && o > e && o >= 20) {
    lookParts.push(`合同负债增速（${r1(o)}%）高于利润增速，表明未来业务储备也在快速增加`);
  } else if (o != null) {
    if (o >= 20) lookParts.push(`合同负债增长${r1(o)}%，表明客户订单/预付款在增加，需求不弱`);
    else if (o > -10) lookParts.push("合同负债基本平稳，需求没有明显变化");
    else lookParts.push(`合同负债下降${r1(-o)}%，表明新增需求在走弱`);
  }
  if (inv != null) {
    if (o != null && inv - o > 30) lookParts.push(`存货涨得比合同负债快（+${r1(inv)}%），要警惕货压在手里卖不动`);
    else if (inv >= 10) lookParts.push("存货同步增长，反映企业正在提前备货以应对后续需求");
    else if (inv >= 0) lookParts.push("存货小幅增加，备货节奏温和");
    else lookParts.push("存货在下降，企业没有囤货意愿");
  }
  const look = lookParts.length ? lookParts.join("；") + "。" : "";

  // 需要注意：订单≠利润、库存双刃剑、资本开支
  const cautions: string[] = [];
  if (o != null && inv != null && inv - o > 30) {
    cautions.push("存货增速明显快于订单（合同负债），如果需求没有跟上，库存积压会侵蚀后续利润");
  } else if (o != null) {
    cautions.push(
      inv != null
        ? "合同负债增长并不等于未来利润一定增长：如果后续订单顺利兑现、库存顺利消化，当前备货有利于承接需求；反之，若需求不及预期，较快的库存增长可能转化为经营压力"
        : "合同负债增长并不等于未来利润一定增长，订单能否顺利兑现仍需跟踪",
    );
  } else if (inv != null && inv >= 30) {
    cautions.push("存货增速偏高，若需求跟不上，库存积压会侵蚀后续利润");
  }
  if (capex == null) {
    cautions.push("资本开支数据暂缺，因此暂时无法判断行业是否正在同步大规模扩产");
  } else if (capex >= 30) {
    cautions.push(`资本开支同比大增(${signed(capex)})，行业在同步扩产，需留意未来供给是否过剩`);
  } else if (capex <= -20) {
    cautions.push(`资本开支在收缩(${signed(capex)})，行业扩产意愿谨慎`);
  } else {
    cautions.push(`资本开支基本持平(${signed(capex)})，扩产节奏温和`);
  }
  const caution = cautions.length ? cautions.join("。") + "。" : "";
  return { headline, body, look, caution };
}

// ── 产业周期健康度（Phase2 路线①解锁）──
// 价格分量 = 节点商品期货月均价 6 月斜率（2026-09-29 接入）；
// 财务分量 = 行业成分股三表聚合（2026-09-29 用户点题接入）：利润/订单(合同负债)/存货/资本开支 同比。
// 板块分 = 50 + Σ(权重×信号)/Σ权重 × 50（0–100，50=中性）；分量缺读数不参与、权重摊给其余；全缺 → null（缺读数≠0）。
export interface SectorFundamentals {
  earnings_yoy?: number | null;
  orders_yoy?: number | null;
  inventory_yoy?: number | null;
  capex_yoy?: number | null;
  earnings_period?: string | null;
  orders_period?: string | null;
  inventory_period?: string | null;
  capex_period?: string | null;
  sampled?: number;
  total?: number;
}

export function computeIndustryHealth(
  links: { nodeId: string; role?: string }[],
  metricSnapshots: Record<string, { date: string; price_trend?: number | null }[]>,
  asOf?: string,
  fundamentals?: SectorFundamentals | null,
): number | null {
  const monthCut = asOf ? asOf.slice(0, 7) : null;
  const w = TH.finWeights;
  const parts: { weight: number; signal: number }[] = [];
  // 价格分量（产业链节点）
  const priceSignals: number[] = [];
  for (const l of links) {
    const snaps = metricSnapshots[l.nodeId];
    if (!snaps || !snaps.length) continue;
    const pts = snaps
      .filter((s) => (monthCut ? s.date <= monthCut : true) && typeof s.price_trend === "number" && (s.price_trend as number) > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (pts.length < TH.industryMinMonths) continue;
    const first = pts[pts.length - TH.industryMinMonths].price_trend as number;
    const last = pts[pts.length - 1].price_trend as number;
    if (!(first > 0)) continue;
    priceSignals.push(clamp(((last / first - 1) * 100) / TH.industryPriceFull, -1, 1));
  }
  if (priceSignals.length) parts.push({ weight: w.price, signal: priceSignals.reduce((a, b) => a + b, 0) / priceSignals.length });
  // 财务分量（财报有披露期：asOf 未到披露期的不用，防回放前视）
  if (fundamentals) {
    const fin = [
      { k: "earnings", full: TH.finEarningsFull, weight: w.earnings, sign: 1 },
      { k: "orders", full: TH.finOrdersFull, weight: w.orders, sign: 1 },
      { k: "inventory", full: TH.finInventoryFull, weight: w.inventory, sign: -1 }, // 累库=负贡献
      { k: "capex", full: TH.finCapexFull, weight: w.capex, sign: 1 },
    ] as const;
    for (const f of fin) {
      const yoy = fundamentals[`${f.k}_yoy`];
      const period = fundamentals[`${f.k}_period`];
      if (typeof yoy !== "number" || !period) continue;
      if (monthCut && period.slice(0, 7) > monthCut) continue;
      parts.push({ weight: f.weight, signal: clamp((f.sign * yoy) / f.full, -1, 1) });
    }
  }
  if (!parts.length) return null;
  const wsum = parts.reduce((a, b) => a + b.weight, 0);
  return r1(clamp(50 + (parts.reduce((a, b) => a + b.signal * b.weight, 0) / wsum) * 50));
}

// ── 扫描器（全市场）───────────────────────────────────────────────
export function scanAll(asOf?: string): ScannerResult {
  const { date, industries } = latestDay(asOf);
  const rows: SectorRow[] = industries.map((ind) => {
    const r = analyzeSector(ind.name, asOf)!;
    return {
      sector: r.sector,
      stage: r.stage,
      stageTone: r.stageTone,
      delta: r.delta.tone,
      deltaLabel: r.delta.label,
      shortPullback: r.scores.shortPullback,
      midTop: r.scores.midTop,
      trendDamage: r.scores.trendDamage,
      industryHealth: r.scores.industryHealth,
    };
  });
  // 按综合风险（中期顶部风险为主，趋势破坏为辅）降序
  const risk = (r: SectorRow) => Math.max(r.midTop, r.trendDamage) + (r.stage === "趋势反转" ? 10 : 0);
  rows.sort((a, b) => risk(b) - risk(a));

  const statusSummary = {
    trendBreak: rows.filter((r) => r.stage === "趋势反转").length,
    topWatch: rows.filter((r) => r.stage === "顶部形成中").length,
    highPullback: rows.filter((r) => r.stage === "趋势内回撤").length,
    downtrend: rows.filter((r) => r.stage === "下行延续").length,
    healthy: rows.filter((r) => r.stage === "趋势健康").length,
  };
  const movers = [...industries].sort((a, b) => (b.medianChange ?? 0) - (a.medianChange ?? 0));
  const up = movers.slice(0, 3).map((x) => `${x.name} ↑${r1(x.medianChange)}%`);
  const down = movers.slice(-3).map((x) => `${x.name} ↓${r1(x.medianChange)}%`);
  return {
    scanDate: date,
    sectorCount: industries.length,
    statusSummary,
    levels: ["申万行业"],
    rows,
    biggestMovers: [...up, ...down],
  };
}
