// Quant Research Lab — 候选因子模板（按 9 大类目；参数网格驱动候选生成）
// AI_Discovered 类因子由 Phase 11 的 Agent 研究流水线生成，同样走本表格式。

export interface FactorTemplate {
  expr: string; // 含 {param} 占位符
  name: string; // 中文名
  category:
    | "Price" | "Volume" | "Momentum" | "Trend" | "Reversal"
    | "Volatility" | "Fundamental" | "Microstructure" | "AI_Discovered";
  grid: Record<string, number[]>; // 参数网格
  directionHint?: 1 | -1; // 1=值越大越好；未指明由数据决定
}

export const FACTOR_TEMPLATES: FactorTemplate[] = [
  // ---------- Momentum ----------
  { expr: "roc(c, {w})", name: "动量-{w}日", category: "Momentum", grid: { w: [5, 10, 20, 60] } },
  { expr: "sub(c, ma(c, {w}))", name: "价格偏离MA{w}", category: "Momentum", grid: { w: [10, 20, 60] } },

  // ---------- Reversal ----------
  { expr: "neg(roc(c, {w}))", name: "反转-{w}日", category: "Reversal", grid: { w: [3, 5, 10] } },

  // ---------- Volatility ----------
  { expr: "neg(std(ret, {w}))", name: "低波动-{w}日", category: "Volatility", grid: { w: [10, 20, 60] } },

  // ---------- Trend ----------
  { expr: "div(c, ma(c, {w}))", name: "趋势强度MA{w}", category: "Trend", grid: { w: [10, 20, 60] } },
  { expr: "corr(c, v, {w})", name: "量价相关-{w}日", category: "Trend", grid: { w: [10, 20] } },

  // ---------- Volume ----------
  { expr: "roc(v, {w})", name: "量能变化-{w}日", category: "Volume", grid: { w: [5, 10, 20] } },
  { expr: "div(ma(v, {w}), ma(v, 60))", name: "量比-{w}日", category: "Volume", grid: { w: [5, 10, 20] } },

  // ---------- Price ----------
  { expr: "div(sub(c, min(l, {w})), max2(sub(max(h, {w}), min(l, {w})), 0.01))", name: "区间位置-{w}日", category: "Price", grid: { w: [20, 60] } },

  // ---------- Fundamental（快照口径） ----------
  { expr: "neg(pe)", name: "低市盈率", category: "Fundamental", grid: {} },
  { expr: "neg(pb)", name: "低市净率", category: "Fundamental", grid: {} },
  { expr: "neg(cap)", name: "小市值", category: "Fundamental", grid: {} },

  // ---------- Microstructure（可用字段有限：用日频近似） ----------
  { expr: "neg(div(std(h, {w}), std(l, {w})))", name: "高低波比-{w}日", category: "Microstructure", grid: { w: [10, 20] } },
  { expr: "neg(div(std(ret, {w}), ma(amount, {w})))", name: "振幅流动比-{w}日", category: "Microstructure", grid: { w: [10] } },
];

// 展开模板 × 参数网格 → 候选因子
export interface CandidateFactor {
  factorKey: string; // 如 roc_c_20
  name: string;
  category: FactorTemplate["category"];
  expression: string; // 已代入参数
  params: Record<string, number>;
  directionHint?: 1 | -1;
}

export function expandTemplates(templates: FactorTemplate[] = FACTOR_TEMPLATES): CandidateFactor[] {
  const out: CandidateFactor[] = [];
  for (const tpl of templates) {
    const keys = Object.keys(tpl.grid);
    const combos: Record<string, number>[] = [{}];
    for (const k of keys) {
      const next: Record<string, number>[] = [];
      for (const base of combos) {
        for (const v of tpl.grid[k]) next.push({ ...base, [k]: v });
      }
      combos.length = 0;
      combos.push(...next);
    }
    for (const params of combos) {
      let expr = tpl.expr;
      let keyPart = tpl.expr;
      for (const [k, v] of Object.entries(params)) {
        expr = expr.replaceAll(`{${k}}`, String(v));
        keyPart = keyPart.replaceAll(`{${k}}`, String(v));
      }
      const factorKey = keyPart
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();
      const name = Object.entries(params).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), tpl.name);
      out.push({ factorKey, name, category: tpl.category, expression: expr, params, directionHint: tpl.directionHint });
    }
  }
  return out;
}

// 因子组合（Stage 4+）：从强因子生成算术组合候选
export function combineFactors(top: { expression: string; factorKey: string }[], maxCombos = 8): CandidateFactor[] {
  const out: CandidateFactor[] = [];
  const ops: { op: string; sym: string }[] = [
    { op: "add", sym: "加" }, { op: "sub", sym: "减" },
  ];
  for (let i = 0; i < top.length && out.length < maxCombos; i++) {
    for (let j = i + 1; j < top.length && out.length < maxCombos; j++) {
      for (const { op, sym } of ops) {
        const expr = `${op}(${top[i].expression}, ${top[j].expression})`;
        out.push({
          factorKey: `${op}_${top[i].factorKey}_${top[j].factorKey}`,
          name: `${top[i].factorKey} ${sym} ${top[j].factorKey}`,
          category: "AI_Discovered",
          expression: expr,
          params: {},
        });
      }
    }
  }
  return out;
}
