// 主线判定纯规则（无 IO），供 node:test 直跑。
export type ThemeRole = "main" | "sub" | "rotation" | "watch";

export interface ThemeScoreInput {
  code: string;
  name: string;
  changePct: number;
  mainYi: number;
  rps: number;
  diffusion: number | null; // 上涨家数占比 0-1；无成分数据为 null
  streakPct: number | null; // 连续收阳/上涨天数；无日K为 null
  streakInflow: number | null; // 连续主力净流入天数
  /**
   * P15-R4：行业 / 概念归属。评分规则不读它（additive，p2 测试零影响），
   * 只为「主题总览」的去选股递棒带上——递板选股必须知道这是行业榜还是概念榜。
   */
  kind?: "industry" | "concept";
}

export interface ThemeScored extends ThemeScoreInput {
  score: number;
  role: ThemeRole;
  reasons: string[];
}

export function scoreTheme(row: ThemeScoreInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  score += Math.max(0, Math.min(100, row.rps)) * 0.35;
  if (row.diffusion !== null) {
    score += row.diffusion * 100 * 0.3;
    if (row.diffusion >= 0.55) reasons.push(`内部扩散 ${(row.diffusion * 100).toFixed(0)}%`);
    else if (row.diffusion < 0.35) reasons.push(`扩散偏弱 ${(row.diffusion * 100).toFixed(0)}%`);
  }
  if (row.streakPct !== null) {
    score += Math.min(10, Math.max(0, row.streakPct)) * 2.5;
    if (row.streakPct >= 3) reasons.push(`连续强势 ${row.streakPct} 日`);
  }
  if (row.streakInflow !== null && row.streakInflow > 0) {
    score += Math.min(8, row.streakInflow) * 1.5;
    reasons.push(`资金连续流入 ${row.streakInflow} 日`);
  }
  if (row.mainYi > 0 && row.changePct > 0) {
    score += 8;
    reasons.push("价量资金同向");
  } else if (row.mainYi < 0 && row.changePct > 1.5) {
    reasons.push("涨价但主力净流出（资金不同步）");
    score -= 6;
  }
  if (row.changePct >= 2) reasons.push(`涨幅 ${row.changePct.toFixed(2)}%`);
  return { score, reasons };
}

export function assignThemeRoles(rows: ThemeScoreInput[]): ThemeScored[] {
  const scored: ThemeScored[] = rows.map((r) => {
    const { score, reasons } = scoreTheme(r);
    return { ...r, score, reasons, role: "watch" };
  });
  scored.sort((a, b) => b.score - a.score);

  const mains: ThemeScored[] = [];
  const subs: ThemeScored[] = [];
  const rotations: ThemeScored[] = [];

  for (const r of scored) {
    const rot =
      r.changePct >= 2 &&
      (r.mainYi < 0 || (r.diffusion !== null && r.diffusion < 0.35));
    const mainOk =
      r.score >= 42 &&
      r.changePct >= 1 &&
      (r.diffusion === null || r.diffusion >= 0.45) &&
      r.mainYi >= 0;
    const subOk = r.score >= 32 && r.changePct >= 0.3 && r.mainYi >= 0; // 0.3：与 p2-rules 测试口径对齐（0.4% 温和强势+资金连续流入应为次主线）

    if (rot && mains.length + subs.length >= 1) {
      r.role = "rotation";
      r.reasons.push("判定：轮动/跟风（涨幅高但资金或扩散不同步）");
      rotations.push(r);
    } else if (mainOk && mains.length < 2) {
      r.role = "main";
      r.reasons.push("判定：主线");
      mains.push(r);
    } else if (subOk && subs.length < 3) {
      r.role = "sub";
      r.reasons.push("判定：次主线");
      subs.push(r);
    } else {
      r.role = "watch";
    }
  }
  return [...mains, ...subs, ...rotations, ...scored.filter((r) => r.role === "watch")];
}

// ==========================================================================
// P15-R5：主题「热度 / 置信 / 次日风险 / 追避」四规则读数
//
// 用户拍板「用自己的算法模仿稳智，要求真实」。稳智那几个分（theme_heat / confidence /
// nextday_risk / rising·avoid）是后端 / LLM 产物、前端爬不到公式（见项目记忆）。
// 这里不照抄黑箱，而是拿**本页已经实测抓到的真实字段**，套公开的「多因子截面合成」方法
// （各信号先转分位/映射 → 去缺失项 → 按可得项重新归一 → 加权求和）自己算一版透明分：
//   · 每一项权固定、每一分可回溯到具体读数；
//   · 某维度断源就不计它的分母（宁可少算，绝不拿 0 顶替，与全站 fundsMissing 同一纪律）；
//   · 置信度 = 证据一致性 × 数据齐全度——缺源越多分越低，把断源变成看得见的扣分；
//   · 次日风险只是「追高的过热/背离读数」，**不是明日涨跌概率**，页面必须这样标。
// 纯函数、无 IO，供 node:test 直跑。scoreTheme/assignThemeRoles 不受影响（p2 测试零改动）。
// ==========================================================================

export interface ThemeEnv {
  /** 全市场炸板率 %（fetchRisk.break_rate）。null = 触板为 0 或该读数缺失 → 不计入风险分母 */
  breakRate: number | null;
  /** 主力净额是否可信。false = 东财板块榜断源走腾讯兜底（mainYi 是占位 0）→ 热度/风险的资金项一律剔除 */
  fundsAvailable: boolean;
}

export type ThemeVerdict = "rising" | "avoid" | "watch";

export interface ThemeMetrics {
  heat: number;               // 0-100 热度合成分（截面分位加权，去缺失重归一）
  confidence: number;         // 0-100 置信 = 证据一致度 × 数据齐全度
  confidenceLabel: "高" | "中" | "低";
  risk: number;               // 0-100 次日过热/背离读数（越高越危险），非涨跌概率
  riskLabel: "低" | "中" | "高";
  verdict: ThemeVerdict;
  verdictReason: string;
  heatParts: string[];        // 计入热度的分项（含被剔除的缺源项，如实列出）
  riskParts: string[];        // 主要风险来源（读数 ≥50 的项）
  confidenceNote: string;     // 「X/5 维有数据 · Y 项同向」
}

const clamp01_100 = (v: number) => (isFinite(v) ? Math.max(0, Math.min(100, v)) : 0);

/** 截面百分位（0-100）：榜内比它低的比例。单样本给中性 50，null 原样留 null。 */
function ranks(vals: (number | null)[]): (number | null)[] {
  const present = vals.filter((v): v is number => v !== null && isFinite(v));
  const m = present.length;
  return vals.map((v) => {
    if (v === null || !isFinite(v)) return null;
    if (m === 1) return 50;
    const below = present.filter((x) => x < v).length;
    return (below / (m - 1)) * 100;
  });
}

/** 单行热度：可用信号加权合成，缺项剔除并按可得权重重新归一（同稳智情绪温度 renormalize 家族）。 */
function heatOf(r: ThemeScoreInput, chgRank: number | null, mainRank: number | null, env: ThemeEnv) {
  const parts: { v: number; w: number; label: string }[] = [];
  const dropped: string[] = [];
  parts.push({ v: clamp01_100(r.rps), w: 0.30, label: `榜内RPS ${r.rps.toFixed(0)}` });
  if (r.diffusion !== null) parts.push({ v: r.diffusion * 100, w: 0.20, label: `内部扩散 ${(r.diffusion * 100).toFixed(0)}%` });
  else dropped.push("内部扩散（成分快照无返回）");
  if (env.fundsAvailable && mainRank !== null) parts.push({ v: mainRank, w: 0.20, label: `主力强度分位 ${mainRank.toFixed(0)}` });
  else dropped.push("主力净额（" + (env.fundsAvailable ? "无读数" : "板块资金断源·腾讯兜底") + "，剔除不计）");
  if (chgRank !== null) parts.push({ v: chgRank, w: 0.15, label: `涨幅榜内分位 ${chgRank.toFixed(0)}` });
  else dropped.push("当日涨幅（无读数）");
  if (r.streakPct !== null) parts.push({ v: (Math.min(Math.max(r.streakPct, 0), 6) / 6) * 100, w: 0.15, label: `连涨 ${r.streakPct} 日` });
  else dropped.push("连涨天数（板块日K无返回）");
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  const heat = wsum > 0 ? Math.round(parts.reduce((a, p) => a + p.v * p.w, 0) / wsum) : 0;
  return { heat, parts, dropped };
}

/** 单行置信：同向比例（一致度）与可得维度比例（齐全度）加权。缺源越多、越反相，置信越低。 */
function confidenceOf(r: ThemeScoreInput, env: ThemeEnv) {
  const checks: { up: boolean; label: string }[] = [];
  checks.push({ up: r.rps >= 50, label: "RPS 过半" });
  checks.push({ up: r.changePct > 0, label: "当日收涨" });
  if (env.fundsAvailable) checks.push({ up: r.mainYi > 0, label: "主力净流入" });
  if (r.diffusion !== null) checks.push({ up: r.diffusion >= 0.5, label: "扩散过半" });
  if (r.streakPct !== null) checks.push({ up: r.streakPct >= 1, label: "连涨强势" });
  const present = checks.length;              // 有数据的维度数
  const positives = checks.filter((c) => c.up).length;
  const agreement = present ? positives / present : 0;
  const coverage = present / 5;               // 满配 5 维（RPS/涨幅/资金/扩散/连涨）
  const confidence = Math.round(100 * (0.6 * agreement + 0.4 * coverage));
  // 分档：数值达标还不够，还得有足够维度撑腰——断源日只剩 2/3 维时封顶「中」，绝不冒称「高」。
  const label: "高" | "中" | "低" = (present >= 4 && confidence >= 70) ? "高" : confidence >= 40 ? "中" : "低";
  return { confidence, label, note: `${present}/5 维有数据 · ${positives}/${present} 项同向` };
}

/** 单行次日风险：涨幅过陡 / 连涨高位 / 价量背离 / 全市场炸板 / 假涨（涨幅高扩散弱）。 */
function riskOf(r: ThemeScoreInput, env: ThemeEnv) {
  const parts: { v: number; w: number; label: string }[] = [];
  const dropped: string[] = [];
  const stretch = clamp01_100((Math.max(r.changePct, 0) / 7) * 100);
  parts.push({ v: stretch, w: 0.22, label: `涨幅陡（${r.changePct.toFixed(2)}%）` });
  if (r.streakPct !== null) parts.push({ v: (Math.min(Math.max(r.streakPct, 0), 6) / 6) * 100, w: 0.18, label: `连涨 ${r.streakPct} 日偏高` });
  else dropped.push("连涨高位");
  if (env.fundsAvailable) {
    const div = r.mainYi < 0 && r.changePct > 1 ? 100 : r.mainYi < 0 && r.changePct > 0 ? 60 : 0;
    parts.push({ v: div, w: 0.25, label: "涨价但主力净流出（背离）" });
  } else dropped.push("价量背离");
  if (env.breakRate !== null) parts.push({ v: clamp01_100(env.breakRate), w: 0.20, label: `全市场炸板率 ${env.breakRate.toFixed(0)}%` });
  else dropped.push("全市场炸板率");
  if (r.diffusion !== null) {
    const fake = r.changePct >= 3 && r.diffusion < 0.4 ? 90 : r.changePct >= 2 && r.diffusion < 0.5 ? 50 : 0;
    parts.push({ v: fake, w: 0.15, label: "涨幅高但扩散弱（拉权重假涨）" });
  } else dropped.push("假涨识别");
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  const risk = wsum > 0 ? Math.round(parts.reduce((a, p) => a + p.v * p.w, 0) / wsum) : 0;
  const label: "低" | "中" | "高" = risk >= 60 ? "高" : risk >= 35 ? "中" : "低";
  const top = parts.filter((p) => p.v >= 50).sort((a, b) => b.v - a.v).map((p) => p.label);
  return { risk, label, top, dropped };
}

/** 一批主题 → 附四读数。rising 清单上限 3 条（按热度取前 3 达标者，不凑数；其余降观察）。 */
export function enrichThemes<T extends ThemeScoreInput>(rows: T[], env: ThemeEnv): (T & ThemeMetrics)[] {
  const chgRanks = ranks(rows.map((r) => r.changePct));
  const mainRanks = env.fundsAvailable ? ranks(rows.map((r) => r.mainYi)) : rows.map(() => null);
  const enriched = rows.map((r, i) => {
    const h = heatOf(r, chgRanks[i], mainRanks[i], env);
    const c = confidenceOf(r, env);
    const k = riskOf(r, env);
    return { ...r, heat: h.heat, confidence: c.confidence, confidenceLabel: c.label, confidenceNote: c.note,
      risk: k.risk, riskLabel: k.label, heatParts: [...h.parts.map((p) => p.label), ...h.dropped.map((d) => `剔除：${d}`)],
      riskParts: k.top.length ? k.top : ["无 ≥50 的显著风险项"], verdict: "watch" as ThemeVerdict, verdictReason: "" };
  });
  // 追/避判定：先看回避（风险高 或 高分但证据不一致），再看可关注（热/信双高且未过热）
  for (const r of enriched) {
    if (r.risk >= 65) { r.verdict = "avoid"; r.verdictReason = `次日过热/背离读数偏高（${r.risk}）：${r.riskParts[0]}`; }
    else if (r.heat >= 50 && r.confidence < 35) { r.verdict = "avoid"; r.verdictReason = `热度尚可但证据不一致（置信 ${r.confidence}·${r.confidenceNote}）`; }
    else if (r.heat >= 65 && r.confidence >= 55 && r.risk <= 45) { r.verdict = "rising"; r.verdictReason = `热度 ${r.heat}·置信 ${r.confidence}·未过热（风险 ${r.risk}）`; }
    else { r.verdict = "watch"; r.verdictReason = `热度 ${r.heat}·置信 ${r.confidence}·风险 ${r.risk}，未达可关注线`; }
  }
  // rising 封顶 3：按 heat 倒序保留前 3，其余改判 watch（对齐稳智「最多 3 个方向、不凑数量」）
  const risings = enriched.filter((r) => r.verdict === "rising").sort((a, b) => b.heat - a.heat);
  for (const r of risings.slice(3)) { r.verdict = "watch"; r.verdictReason = `与热度前 3 的达标方向比排序靠后，本页封顶 3 条不凑数（${r.verdictReason}）`; }
  return enriched;
}
