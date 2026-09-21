// 快照条件字段可得性预检 — 纯核（零 IO、零 import，node --test 可直跑）
//
// 为什么单独成文件：这段判定决定了「选不出来」该怎么向用户解释——
// 字段整池无读数时把条件放进粗筛，等于全池判不符合，页面上只剩「无命中结果」，
// 把「数据缺失」伪装成「没有股票符合」。预检把它拆穿：可用条件继续评，
// 全缺条件剔除并登记缺口，由调用方（runScreener）显式告警。
// 口径与「已登记未实现因子：忽略 + 显式提示」同一条纪律，绝不静默。

export interface SnapCondLike {
  field: string;
}

export interface UnavailableSnapField {
  field: string;
  total: number; // 参与判定的标的数（供「N 只里没有一条真实读数」文案）
}

/**
 * 把快照口径条件分成「可评」与「整池无读数」两堆。
 * - usable：至少一只标的能取到非 null 值的条件，保持原顺序进入粗筛；
 * - unavailable：全池 valueOf 一律 null 的条件（断源/字段缺失期），逐条登记字段与池大小。
 * 同一字段出现多个条件（不同 op/value）时按字段聚合，只登记一次。
 */
export function partitionUnavailableSnapConds<M, C extends SnapCondLike>(
  conds: C[],
  metas: M[],
  valueOf: (meta: M, field: string) => number | null,
): { usable: C[]; unavailable: UnavailableSnapField[] } {
  const available = new Set<string>();
  for (const c of conds) {
    if (available.has(c.field)) continue;
    if (metas.some((m) => valueOf(m, c.field) !== null)) available.add(c.field);
  }
  const usable: C[] = [];
  const seen = new Set<string>();
  const unavailable: UnavailableSnapField[] = [];
  for (const c of conds) {
    if (available.has(c.field)) {
      usable.push(c);
      continue;
    }
    if (!seen.has(c.field)) {
      seen.add(c.field);
      unavailable.push({ field: c.field, total: metas.length });
    }
  }
  return { usable, unavailable };
}
