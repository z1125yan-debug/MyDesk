// 条件命中矩阵（P36-B，2026-09-30）
//
// 为什么要有它：分档回测要对「110 条策略 × 5500 只 × 800 天」判条件，
// 逐日调 condMetAt 是 40 亿次函数调用，跑不完。这里把「一条条件在整段历史上哪几天成立」
// 一次性算成位图（Uint8Array），策略命中 = 各条件位图按位与。
//
// 语义纪律：比较本身仍然调用 probability.ts 的 cmpWithOp（操作符契约全局只有一份），
// 这里只把「逐日循环 + rolling 窗口」搬进紧循环，不重新定义任何判定语义。
// 正确性靠 tests/quant/p36-b-cond-matrix.test.ts 与 condMetAt 逐点对照钉死。

import { cmpWithOp } from "../factors/probability.ts";

export type Series = (number | null)[];

/** 与策略库/选股器的条件形状一致，但 op/value 放宽（value 允许 in/not in 的多值数组） */
export interface MatCond {
  field: string;
  op: string;
  value: number | string | (number | string)[];
  type?: "single" | "rolling_return" | "rolling_sum" | "rolling_any";
  window?: number;
  min_match_days?: number;
}

export interface CompiledCond extends MatCond {
  /** 去重键（相同条件只算一次位图） */
  key: string;
}

export function condKeyOf(c: MatCond): string {
  const v = Array.isArray(c.value) ? c.value.join("|") : String(c.value);
  return `${c.field}|${c.op}|${v}|${c.type ?? "single"}|${c.window ?? 0}|${c.min_match_days ?? 0}`;
}

function testOf(c: MatCond): (v: number | null) => boolean {
  return (v: number | null) => cmpWithOp(v, c.op, c.value);
}

/**
 * 一条条件在整段历史上的命中位图。series 长度 = T，返回 Uint8Array(T)，1=成立。
 * 序列缺失（null/NaN）一律记 0——「算不出」不当「成立」，与 condMetAt 同。
 */
export function hitMatrixOf(c: MatCond, series: Series | undefined): Uint8Array {
  const T = series?.length ?? 0;
  const out = new Uint8Array(T);
  if (!series) return out;
  const type = c.type ?? "single";
  const test = testOf(c);

  if (type === "single") {
    for (let t = 0; t < T; t++) {
      const v = series[t];
      if (v == null || !Number.isFinite(v)) continue;
      if (test(v)) out[t] = 1;
    }
    return out;
  }

  const w = Math.max(1, Math.min(250, c.window ?? 0));
  if (type === "rolling_return") {
    for (let t = w; t < T; t++) {
      const now = series[t];
      const then = series[t - w];
      if (now == null || then == null || !(then > 0) || !Number.isFinite(now)) continue;
      if (test(((now as number) / (then as number) - 1) * 100)) out[t] = 1;
    }
    return out;
  }
  if (type === "rolling_sum") {
    for (let t = w - 1; t < T; t++) {
      let s = 0;
      let ok = true;
      for (let i = t - w + 1; i <= t; i++) {
        const v = series[i];
        if (v == null || !Number.isFinite(v as number)) { ok = false; break; }
        s += v as number;
      }
      if (ok && test(s)) out[t] = 1;
    }
    return out;
  }
  if (type === "rolling_any") {
    const need = Math.max(1, c.min_match_days ?? 1);
    // 滑动计数：窗口内命中的天数（O(T) 而不是 O(T*w)）
    let hits = 0;
    for (let t = 0; t < T; t++) {
      const v = series[t];
      if (v != null && Number.isFinite(v) && test(v)) hits++;
      const drop = t - w;
      if (drop >= 0) {
        const dv = series[drop];
        if (dv != null && Number.isFinite(dv) && test(dv)) hits--;
      }
      if (t >= w - 1 && hits >= need) out[t] = 1;
    }
    return out;
  }
  return out;
}

/** 多条条件按位与：全部成立才算策略命中 */
export function andMatrices(mats: readonly Uint8Array[], T: number): Uint8Array {
  if (!mats.length) return new Uint8Array(T);
  const out = new Uint8Array(mats[0]);
  for (let i = 1; i < mats.length; i++) {
    const m = mats[i];
    for (let t = 0; t < T; t++) if (out[t] && !m[t]) out[t] = 0;
  }
  return out;
}
