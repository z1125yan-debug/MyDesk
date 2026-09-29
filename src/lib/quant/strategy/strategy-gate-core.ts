// 策略预测闸门纯核（「预测」按钮 P1 刀）：只做纯计算，零 IO、零时钟。
// 输入：今日见顶压力分（0–100，来自 /api/market/sentiment 那套 computeTopPressure）+
//       稳智社区策略全量（data/strategies.json，其中 143 条带 sentiment_threshold）+ 攒样本行数。
// 输出：每条策略今天过不过闸 + 推荐列表（组合/单条）+ 攒样本进度。
//
// 三条硬规矩（写进测试钉死）：
// 1) 档位分拿不到（null/NaN）→ 带前提的策略全部判「unknown」，不出推荐——不猜一个分；
// 2) 每条推荐的 record 恒 null（v1 没有使用台账）：页面显示「还没记过账」，
//    **绝不把市场级概率复制到每条头上冒充「这条的上涨概率」**——市场概率是全市场一个数，单独一行；
// 3) 组合 = 今天过闸策略的明示打包（memberIds 摆出来），不是黑箱；排序按 赞-踩，同分按 id 稳定序。

export interface GateStrategy {
  id: number;
  name: string;
  like: number;
  dislike: number;
  /** 已映射到本站因子 key 的条件数（0 条 = 本地跑不了，不进推荐） */
  n_mapped: number;
  /** backtest_params.sentiment_threshold；null = 没设前提（永远不挡，也不进推荐排位） */
  threshold: number | null;
  /** backtest_params.sentiment_mode，">=" / "<="，缺省 ">=" */
  mode: string;
}

export interface GateVerdict {
  pass: boolean;
  /** true = 档位分没算出来，今天不判（页面显示「待判」而不是「被挡」） */
  unknown: boolean;
  reason: string;
}

export interface ForecastItem {
  kind: "combo" | "single";
  key: string;
  name: string;
  memberIds: number[];
  /** 来源一行：组合=系统打包（成员来自稳智策略库）；单条=稳智策略库 */
  source: string;
  /** 为什么推它：真实读数（今天几分、门槛多少、赞踩），不写玄学 */
  reason: string;
  /** v1 恒 null：使用台账还没建。类型留着，P3 台账上线后填 {used, up, horizon} */
  record: null;
}

export interface ForecastPack {
  counts: { total: number; gated: number; pass: number; blocked: number; unknown: number };
  /** 按策略 id 的闸门判定（只含带前提的；前端拿它做「只显示能用的」折叠） */
  gates: Record<string, { pass: boolean; unknown: boolean; threshold: number }>;
  items: ForecastItem[];
  marketProb: { state: "accumulating"; n: number; target: number; note: string };
  /** false = 档位分没算出来（items 为空，页面如实说「档位分没算出来」） */
  tierOk: boolean;
}

const round0 = (v: number): number => Math.round(v);

/** 单条策略的闸门判定。没设前提 = 不挡（pass:true 且 unknown:false，reason 空） */
export function gateOf(
  s: { threshold: number | null; mode?: string },
  score: number | null,
): GateVerdict {
  if (s.threshold == null) return { pass: true, unknown: false, reason: "" };
  if (score == null || !Number.isFinite(score)) {
    return { pass: false, unknown: true, reason: "档位分没算出来，今天不判" };
  }
  const mode = s.mode === "<=" ? "<=" : ">=";
  const pass = mode === "<=" ? score <= s.threshold : score >= s.threshold;
  const diff = Math.abs(round0(score) - s.threshold);
  return {
    pass,
    unknown: false,
    reason: pass
      ? `前提 ${mode}${s.threshold} 成立（今天 ${round0(score)} 分）`
      : `前提 ${mode}${s.threshold}，今天 ${round0(score)} 分，还差 ${diff} 分`,
  };
}

/** 赞-踩 排序（同分按 id 升序，保证同一份数据两次打包结果一致） */
function byVotes(a: GateStrategy, b: GateStrategy): number {
  const va = (a.like ?? 0) - (a.dislike ?? 0);
  const vb = (b.like ?? 0) - (b.dislike ?? 0);
  if (vb !== va) return vb - va;
  return a.id - b.id;
}

/**
 * 攒样本进度。v1 只报进度不出数字：条件概率引擎（P1 加 Wilson 区间那套）上线后
 * 才会把「像今天的日子次日涨跌」算出来——在那之前 n>=target 也只说「样本已攒够」，
 * 不拿无条件 base rate 冒充条件概率。
 */
export function marketProbState(
  n: number,
  target: number,
): { state: "accumulating"; n: number; target: number; note: string } {
  const rows = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const note =
    rows >= target
      ? `样本已攒够（${rows}/${target} 天），等条件概率引擎校准上线后这里出数`
      : `每日收盘自动存档攒样本中（${rows}/${target} 天）——攒够后这里才出「像今天的日子次日涨跌多少」`;
  return { state: "accumulating", n: rows, target, note };
}

/** 打包今天的推荐：组合（过闸策略两两打包，至多 2 个）+ 单条（至多 3 条），组合在前。 */
export function packForecast(input: {
  score: number | null;
  tier: string;
  strategies: GateStrategy[];
  snapshotRows: number;
  target?: number;
}): ForecastPack {
  const target = input.target ?? 30;
  const gated = input.strategies.filter((s) => s.threshold != null);
  const gates: Record<string, { pass: boolean; unknown: boolean; threshold: number }> = {};
  let pass = 0;
  let unknown = 0;

  for (const s of gated) {
    const v = gateOf(s, input.score);
    if (v.unknown) unknown += 1;
    else if (v.pass) pass += 1;
    gates[String(s.id)] = { pass: v.pass, unknown: v.unknown, threshold: s.threshold as number };
  }

  const items: ForecastItem[] = [];
  const tierOk = input.score != null && Number.isFinite(input.score);
  if (tierOk) {
    const score0 = round0(input.score as number);
    // 候选 = 过闸 且 本地能跑（n_mapped>0，n_mapped=0 的条件装进筛选也筛不出东西）
    const passing = gated
      .filter((s) => gates[String(s.id)]?.pass && s.n_mapped > 0)
      .sort(byVotes);

    // 组合：按票数序相邻配对（1+2、3+4），至多 2 个——配对规则简单明示，不搞黑箱打分
    const pairs: GateStrategy[][] = [];
    for (let i = 0; i + 1 < passing.length && pairs.length < 2; i += 2) {
      pairs.push([passing[i], passing[i + 1]]);
    }
    for (const pair of pairs) {
      items.push({
        kind: "combo",
        key: `combo-${pair.map((s) => s.id).join("-")}`,
        name: pair.map((s) => s.name).join(" + "),
        memberIds: pair.map((s) => s.id),
        source: "来源：系统打包 · 成员来自稳智策略库",
        reason: `两条前提都成立（今天 ${score0} 分）· ${pair.map((s) => `赞${s.like ?? 0}/踩${s.dislike ?? 0}`).join(" · ")}`,
        record: null,
      });
    }
    for (const s of passing.slice(0, 3)) {
      items.push({
        kind: "single",
        key: `single-${s.id}`,
        name: s.name,
        memberIds: [s.id],
        source: "来源：稳智策略库（社区单条）",
        reason: `${gateOf(s, input.score).reason} · 赞${s.like ?? 0}/踩${s.dislike ?? 0}`,
        record: null,
      });
    }
  }

  return {
    counts: {
      total: input.strategies.length,
      gated: gated.length,
      pass,
      blocked: gated.length - pass - unknown,
      unknown,
    },
    gates,
    items,
    marketProb: marketProbState(input.snapshotRows, target),
    tierOk,
  };
}
