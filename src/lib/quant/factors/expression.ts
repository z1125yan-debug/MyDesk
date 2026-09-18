// Quant Research Lab — 因子表达式 DSL
// 安全性：白名单函数 + 递归下降解析（绝不 eval 用户字符串）。
// 时序约定：ref(x, n) 取 n 天【之前】的值；n ≥ 0。负数偏移 = 引用未来 → 审计直接拒绝。
import type { Panel } from "./panel.ts";

type Val = number | null;
export type Series = Val[]; // 单股票时间序列

type Node =
  | { kind: "num"; v: number }
  | { kind: "field"; name: string }
  | { kind: "call"; fn: string; args: Node[] };

// ---------- 词法 ----------

interface Token {
  t: "num" | "id" | "op" | "lparen" | "rparen" | "comma";
  v: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ t: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z_0-9]/.test(src[j])) j++;
      tokens.push({ t: "id", v: src.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ("+-*/".includes(ch)) { tokens.push({ t: "op", v: ch }); i++; continue; }
    if (ch === "(") { tokens.push({ t: "lparen", v: ch }); i++; continue; }
    if (ch === ")") { tokens.push({ t: "rparen", v: ch }); i++; continue; }
    if (ch === ",") { tokens.push({ t: "comma", v: ch }); i++; continue; }
    throw new Error(`表达式含非法字符：${ch}`);
  }
  return tokens;
}

// ---------- 白名单 ----------

export const FIELD_ALIASES: Record<string, string> = {
  o: "o", open: "o",
  h: "h", high: "h",
  l: "l", low: "l",
  c: "c", close: "c",
  v: "v", volume: "v", vol: "v",
  amount: "amount", ret: "ret", return: "ret",
  turnover: "turnover", cap: "cap", floatcap: "floatcap",
  pe: "pe", pb: "pb",
};

// 时序函数：window ≥ 1，只看过去
export const TS_FUNCS = new Set(["ref", "ma", "std", "sum", "max", "min", "delta", "roc", "corr"]);
// 截面函数：同一天内跨股票
export const CS_FUNCS = new Set(["rank", "zscore", "minmax", "winsor"]);
// 算术函数
export const ARITH_FUNCS = new Set(["abs", "sign", "log", "neg", "add", "sub", "mul", "div", "min2", "max2", "clamp"]);

export function allKnownFunctions(): string[] {
  return [...TS_FUNCS, ...CS_FUNCS, ...ARITH_FUNCS];
}

// ---------- 解析（优先级：* / 高于 + -） ----------

export function parseExpression(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;

  function peek(): Token | undefined { return tokens[pos]; }
  function next(): Token { return tokens[pos++]; }

  function parsePrimary(): Node {
    const tk = next();
    if (!tk) throw new Error("表达式意外结束");
    if (tk.t === "num") {
      const v = parseFloat(tk.v);
      if (!isFinite(v)) throw new Error(`非法数字：${tk.v}`);
      return { kind: "num", v };
    }
    if (tk.t === "id") {
      if (peek()?.t === "lparen") {
        // 白名单强制：未知函数在解析期直接拒绝（安全性优先）
        if (!TS_FUNCS.has(tk.v) && !CS_FUNCS.has(tk.v) && !ARITH_FUNCS.has(tk.v)) {
          throw new Error(`白名单外函数：${tk.v}（可用：${[...TS_FUNCS, ...CS_FUNCS, ...ARITH_FUNCS].join(" ")}）`);
        }
        next(); // (
        const args: Node[] = [];
        if (peek()?.t !== "rparen") {
          args.push(parseAdditive());
          while (peek()?.t === "comma") { next(); args.push(parseAdditive()); }
        }
        const close = next();
        if (!close || close.t !== "rparen") throw new Error(`${tk.v}() 缺少右括号`);
        return { kind: "call", fn: tk.v, args };
      }
      if (FIELD_ALIASES[tk.v]) return { kind: "field", name: FIELD_ALIASES[tk.v] };
      throw new Error(`未知字段：${tk.v}（可用：${Object.keys(FIELD_ALIASES).join(" ")}）`);
    }
    if (tk.t === "lparen") {
      const inner = parseAdditive();
      const close = next();
      if (!close || close.t !== "rparen") throw new Error("缺少右括号");
      return inner;
    }
    if (tk.t === "op" && (tk.v === "-" || tk.v === "+")) {
      const operand = parsePrimary();
      return tk.v === "-" ? { kind: "call", fn: "neg", args: [operand] } : operand;
    }
    throw new Error(`意外标记：${tk.v}`);
  }

  function parseMultiplicative(): Node {
    let left = parsePrimary();
    while (peek()?.t === "op" && (peek()!.v === "*" || peek()!.v === "/")) {
      const op = next().v;
      const right = parsePrimary();
      left = { kind: "call", fn: op === "*" ? "mul" : "div", args: [left, right] };
    }
    return left;
  }

  function parseAdditive(): Node {
    let left = parseMultiplicative();
    while (peek()?.t === "op" && (peek()!.v === "+" || peek()!.v === "-")) {
      const op = next().v;
      const right = parseMultiplicative();
      left = { kind: "call", fn: op === "+" ? "add" : "sub", args: [left, right] };
    }
    return left;
  }

  const root = parseAdditive();
  if (pos !== tokens.length) throw new Error(`表达式尾部多余内容：${tokens[pos].v}`);
  return root;
}

// ---------- 序列化 ----------

export function serializeExpression(node: Node): string {
  if (node.kind === "num") return fmtNum(node.v);
  if (node.kind === "field") return node.name;
  return `${node.fn}(${node.args.map(serializeExpression).join(", ")})`;
}

function fmtNum(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
}

export function parseAndNormalize(src: string): string {
  return serializeExpression(parseExpression(src));
}

// ---------- 审计（未来函数/数据泄露静态检查） ----------

export interface ExpressionAudit {
  ok: boolean;
  problems: string[];
  maxLookback: number; // 表达式最多回看多少天
  usesCrossSection: boolean;
  fieldsUsed: string[];
}

export function auditExpression(node: Node): ExpressionAudit {
  const problems: string[] = [];
  let maxLookback = 0;
  let usesCrossSection = false;
  const fieldsUsed = new Set<string>();

  function walk(n: Node): void {
    if (n.kind === "field") { fieldsUsed.add(n.name); return; }
    if (n.kind === "num") return;
    const fn = n.fn;
    if (!TS_FUNCS.has(fn) && !CS_FUNCS.has(fn) && !ARITH_FUNCS.has(fn)) {
      problems.push(`未知函数 ${fn}（白名单外）`);
      return;
    }
    if (fn === "ref" || fn === "delta" || fn === "roc") {
      const w = n.args[1];
      if (w && w.kind === "num") {
        if (w.v < 0) problems.push(`未来函数：${fn} 的窗口为负（引用了未来 ${-w.v} 天）`);
        else maxLookback = Math.max(maxLookback, fn === "ref" ? w.v : w.v + 1);
      } else if (w && w.kind === "call" && w.fn === "neg" && w.args[0]?.kind === "num") {
        problems.push(`未来函数：${fn} 的窗口为负（引用了未来 ${w.args[0].v} 天）`);
      } else if (w) {
        problems.push(`${fn} 的窗口必须是常量数字（当前实现不支持动态窗口）`);
      }
    }
    if (fn === "ma" || fn === "std" || fn === "sum" || fn === "max" || fn === "min") {
      const w = n.args[1];
      if (w && w.kind === "num") maxLookback = Math.max(maxLookback, w.v);
    }
    if (fn === "corr") {
      const w = n.args[2];
      if (w && w.kind === "num") maxLookback = Math.max(maxLookback, w.v);
    }
    if (CS_FUNCS.has(fn)) usesCrossSection = true;
    n.args.forEach(walk);
  }
  walk(node);
  return { ok: problems.length === 0, problems, maxLookback, usesCrossSection, fieldsUsed: [...fieldsUsed] };
}

// ---------- 求值 ----------

// 时序算子（单股票序列，null 安全）
function tsRef(x: Series, n: number): Series {
  return x.map((_, t) => (t - n >= 0 ? x[t - n] : null));
}
function tsRoll(x: Series, n: number, agg: (arr: number[]) => number): Series {
  return x.map((_, t) => {
    if (t - n + 1 < 0) return null;
    const win: number[] = [];
    for (let k = t - n + 1; k <= t; k++) if (x[k] !== null) win.push(x[k]!);
    if (win.length < Math.ceil(n * 0.6)) return null; // 窗口内数据不足 60% 视为无效
    const v = agg(win);
    return isFinite(v) ? v : null;
  });
}
const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
const stdOf = (a: number[]): number => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / Math.max(1, a.length - 1));
};

function elementwise2(a: Series, b: Series, f: (x: number, y: number) => number): Series {
  return a.map((va, t) => {
    const vb = b[t];
    return va !== null && vb !== null ? safeNum(f(va, vb)) : null;
  });
}

function safeNum(v: number | null): number | null {
  return v !== null && isFinite(v) ? v : null;
}

// 矩阵级逐元素运算（[股票][日期] 对齐）
function matwise2(a: (number | null)[][], b: (number | null)[][], f: (x: number, y: number) => number): (number | null)[][] {
  return a.map((row, si) =>
    row.map((va, t) => {
      const vb = b[si]?.[t];
      return va !== null && vb !== undefined && vb !== null ? safeNum(f(va, vb)) : null;
    }),
  );
}

// 两序列滚动相关
function tsCorr(a: Series, b: Series, n: number): Series {
  return a.map((_, t) => {
    if (t - n + 1 < 0) return null;
    const xs: number[] = [], ys: number[] = [];
    for (let k = t - n + 1; k <= t; k++) {
      if (a[k] !== null && b[k] !== null) { xs.push(a[k]!); ys.push(b[k]!); }
    }
    if (xs.length < Math.max(5, Math.ceil(n * 0.6))) return null;
    return safeNum(pearson(xs, ys));
  });
}

export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
}

// 截面算子（对某一天的全体股票）
export function csRank(values: Val[]): Val[] {
  const idx = values.map((v, i) => ({ v, i })).filter((p) => p.v !== null);
  idx.sort((a, b) => a.v! - b.v!);
  const out: Val[] = values.map(() => null);
  const n = idx.length;
  idx.forEach((p, r) => { out[p.i] = n > 1 ? r / (n - 1) : 0.5; });
  return out;
}

export function csZscore(values: Val[]): Val[] {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 3) return values.map(() => null);
  const m = mean(nums), sd = stdOf(nums);
  if (sd === 0) return values.map(() => null);
  return values.map((v) => (v !== null ? safeNum((v - m) / sd) : null));
}

export function csMinMax(values: Val[]): Val[] {
  const nums = values.filter((v): v is number => v !== null);
  if (!nums.length) return values.map(() => null);
  const lo = Math.min(...nums), hi = Math.max(...nums);
  if (hi === lo) return values.map(() => 0.5);
  return values.map((v) => (v !== null ? (v - lo) / (hi - lo) : null));
}

export function csWinsor(values: Val[], k = 3): Val[] {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 10) return values;
  const m = mean(nums), sd = stdOf(nums);
  const lo = m - k * sd, hi = m + k * sd;
  return values.map((v) => (v === null ? null : Math.min(hi, Math.max(lo, v))));
}

// 求值：返回 [股票][日期] 的因子值矩阵
export function evaluateAst(node: Node, panel: Panel): (number | null)[][] {
  const symbols = panel.symbols.length;
  const dates = panel.dates.length;

  function evalNode(n: Node): (number | null)[][] {
    if (n.kind === "num") {
      return Array.from({ length: symbols }, () => new Array<number | null>(dates).fill(n.v));
    }
    if (n.kind === "field") {
      const f = panel.fields.get(n.name);
      if (!f) throw new Error(`面板中无字段 ${n.name}`);
      return f;
    }
    const fn = n.fn;
    const args = n.args.map(evalNode);

    if (ARITH_FUNCS.has(fn)) {
      const one = (f: (v: number) => number | null) =>
        args[0].map((series) => series.map((v) => (v === null ? null : safeNum(f(v)))));
      switch (fn) {
        case "abs": return one(Math.abs);
        case "log": return one((v) => (v > 0 ? Math.log(v) : null));
        case "sign": return one(Math.sign);
        case "neg": return one((v) => -v);
        case "add": return args.length === 1 ? args[0] : matwise2(args[0], args[1], (a, b) => a + b);
        case "sub": return matwise2(args[0], args[1], (a, b) => a - b);
        case "mul": return matwise2(args[0], args[1], (a, b) => a * b);
        case "div": return matwise2(args[0], args[1], (a, b) => (b === 0 ? NaN : a / b));
        case "min2": return matwise2(args[0], args[1], Math.min);
        case "max2": return matwise2(args[0], args[1], Math.max);
        case "clamp": {
          const lo = n.args[1]?.kind === "num" ? n.args[1].v : -1e9;
          const hi = n.args[2]?.kind === "num" ? n.args[2].v : 1e9;
          return one((v) => Math.min(hi, Math.max(lo, v)));
        }
      }
    }

    if (TS_FUNCS.has(fn)) {
      const w = n.args[1]?.kind === "num" ? n.args[1].v : NaN;
      switch (fn) {
        case "ref": return args[0].map((s) => tsRef(s, w));
        case "ma": return args[0].map((s) => tsRoll(s, w, mean));
        case "std": return args[0].map((s) => tsRoll(s, w, stdOf));
        case "sum": return args[0].map((s) => tsRoll(s, w, (a) => a.reduce((p, c) => p + c, 0)));
        case "max": return args[0].map((s) => tsRoll(s, w, (a) => Math.max(...a)));
        case "min": return args[0].map((s) => tsRoll(s, w, (a) => Math.min(...a)));
        case "delta": return args[0].map((s) => elementwise2(s, tsRef(s, w), (a, b) => a - b));
        case "roc": return args[0].map((s) => elementwise2(s, tsRef(s, w), (a, b) => (b === 0 ? NaN : a / b - 1)));
        case "corr": return args[0].map((s, si) => tsCorr(s, args[1][si], (n.args[2]?.kind === "num" ? n.args[2].v : w)));
      }
    }

    if (CS_FUNCS.has(fn)) {
      const src = args[0];
      const out: (number | null)[][] = src.map((s) => s.map(() => null));
      for (let t = 0; t < dates; t++) {
        const col: Val[] = src.map((s) => s[t]);
        let transformed: Val[];
        switch (fn) {
          case "rank": transformed = csRank(col); break;
          case "zscore": transformed = csZscore(col); break;
          case "minmax": transformed = csMinMax(col); break;
          case "winsor": transformed = csWinsor(col); break;
          default: transformed = col;
        }
        for (let si = 0; si < symbols; si++) out[si][t] = transformed[si];
      }
      return out;
    }

    throw new Error(`不支持函数：${fn}`);
  }

  return evalNode(node);
}

export function evaluateExpression(src: string, panel: Panel): (number | null)[][] {
  const ast = parseExpression(src);
  const audit = auditExpression(ast);
  if (!audit.ok) throw new Error(`表达式未通过审计：${audit.problems.join("；")}`);
  return evaluateAst(ast, panel);
}

export type { Node };
