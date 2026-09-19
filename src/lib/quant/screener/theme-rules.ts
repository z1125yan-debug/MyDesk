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
