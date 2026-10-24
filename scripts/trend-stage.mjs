// 个股趋势阶段判定（MyDesk 本地计算，只用价格/量结构，不调模型）
//
// 用途：给 AI 优选选出的每只个股，按「决策日收盘」判定它当时处在什么趋势里，
//       随 DSA 深挖报告一起交付。只标注、不拦截、不影响选股（2026-10-23 Z 批准）。
//
// 口径（与选股侧 top-risk-engine 的阶段机对齐，阈值同源）：
//   · 趋势方向（周线）：最近周收盘 vs 周线 MA5/MA10 的位置与排列 → 上升 / 下跌 / 震荡
//   · 阶段（日线五档）：趋势健康 / 趋势内回撤 / 顶部形成中 / 趋势反转 / 下行延续
//     - 长期下行（近60日累计 ≤ −10%）中的破位叫「下行延续」，不叫顶部——
//       前面跌了几个月、回温一点点，不算顶部（top-risk v2 定案，2026-09-29）
//   · 数据只用决策日（含）之前的日K（前复权），无未来函数；不足 65 根日K 返回 null，不硬判。
//   · 量能只做证据描述（近5日放量涨/跌），不参与阶段判定。

export const TREND_TH = {
  reversalBelowMA60: -8, // 距60日线 < 此值(%) = 明显跌破中长期趋势
  reversalDrop: -3, // 当日跌幅 ≤ 此值(%)
  reversalDrawdown20: -12, // 距20日高点 ≤ 此值(%)
  formingBelowMA60Soft: -3, // 跌破60日线（软）
  formingDrop: -2, // 当日明显下跌
  pullbackDrop: -1.5, // 趋势内回撤的当日跌幅门槛
  pullbackAboveMA: 0, // 距60日线 ≥ 此值 = 仍在趋势上方
  downtrendRun60: -10, // 近60日累计 ≤ 此值 = 长期下行
};

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);

/** 裸6位代码 → 带后缀 symbol（与 dsa-deepdive-report 的 sinaCodeOf 同口径） */
export function symbolOf(bare6) {
  const c = String(bare6 || "").trim();
  if (!/^\d{6}$/.test(c)) return null;
  if (c.startsWith("92") || c.startsWith("8")) return `${c}.BJ`;
  if (c.startsWith("6") || c.startsWith("9")) return `${c}.SH`;
  return `${c}.SZ`;
}

/** 从 MyDesk 库取某股截至 asOf（含）的日K（前复权，升序）。db = node:sqlite DatabaseSync */
export function loadBars(db, symbol, asOf, limit = 420) {
  const rows = db
    .prepare(
      "SELECT tradeDate, open, high, low, close, volume FROM stock_daily_bar " +
        "WHERE symbol = ? AND adjust = 'qfq' AND tradeDate <= ? ORDER BY tradeDate DESC LIMIT ?"
    )
    .all(symbol, asOf, limit);
  return rows.reverse();
}

// 当周周一日期（YYYY-MM-DD），用作周线聚合键
function weekKey(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // 周一=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/**
 * bars: 升序日K [{tradeDate, open, high, low, close, volume}]，最后一根 = 判定日。
 * 返回 null（数据不足）或判定结果对象。
 */
export function computeTrendStage(bars) {
  if (!bars || bars.length < 65) return null;
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.volume || 0);
  const close = closes[n - 1];
  const prevClose = closes[n - 2];
  const ma = (k) => mean(closes.slice(-k));
  const ma5 = ma(5), ma10 = ma(10), ma20 = ma(20), ma60 = ma(60);
  const dayChg = (close / prevClose - 1) * 100;
  const chg5 = (close / closes[n - 6] - 1) * 100;
  const chg20 = (close / closes[n - 21] - 1) * 100;
  const chg60 = (close / closes[n - 61] - 1) * 100;
  const distMA60 = (close / ma60 - 1) * 100;
  const high20 = Math.max(...bars.slice(-20).map((b) => b.high));
  const distHigh20 = (close / high20 - 1) * 100;
  const maBull = ma5 > ma10 && ma10 > ma20;
  const maBear = ma5 < ma10 && ma10 < ma20;
  const volRatio = mean(vols.slice(-20)) > 0 ? mean(vols.slice(-5)) / mean(vols.slice(-20)) : null;

  // ── 趋势方向：近端结构（周线排列 + 站上 60 日线 + 近 60 日同向）──
  // 教训（2026-10-23 回算，均为决策日收盘口径）：
  //  · 长均线/半年涨幅会被年内投机尖顶污染（新华百货 2 月冲 19.76 后回落，
  //    120 日线、半年涨幅都还挂着尖顶的影子），拿它们当闸门会把正在走强的
  //    修复趋势误判成下跌——长周期只做「距一年高点」的位置描述，不当闸门。
  //  · 判定不用未来数据：决策日涨停冲压力位的票，标签只能是那天的它；
  //    它后来破位是它 D+1/D+2 的事，战绩会记，不倒推改标签。
  const high250 = Math.max(...bars.slice(-250).map((b) => b.high));
  const distHigh250 = (close / high250 - 1) * 100;
  const wkMap = new Map();
  for (const b of bars) wkMap.set(weekKey(b.tradeDate), b.close);
  const wCloses = [...wkMap.values()];
  let weeklyUp = false, weeklyDown = false;
  if (wCloses.length >= 10) {
    const wma5 = mean(wCloses.slice(-5));
    const wma10 = mean(wCloses.slice(-10));
    const wc = wCloses[wCloses.length - 1];
    weeklyUp = wc > wma5 && wma5 > wma10;
    weeklyDown = wc < wma5 && wma5 < wma10;
  } else {
    weeklyUp = maBull && close > ma60;
    weeklyDown = maBear && close < ma60;
  }
  let direction;
  if (weeklyUp && distMA60 > 0 && chg60 > 0) direction = "上升";
  else if (weeklyDown && distMA60 < 0 && chg60 < 0) direction = "下跌";
  else direction = "震荡";

  // ── 阶段状态机（阈值同 top-risk-engine）──
  const TH = TREND_TH;
  const longDown60 = chg60 <= TH.downtrendRun60;
  const belowHard = distMA60 < TH.reversalBelowMA60;
  const belowSoft = distMA60 < TH.formingBelowMA60Soft;
  const deterioration = maBear || dayChg <= TH.formingDrop;
  let stage;
  if (belowHard && close < ma20 && (dayChg <= TH.reversalDrop || distHigh20 <= TH.reversalDrawdown20)) {
    stage = longDown60 ? "下行延续" : "趋势反转";
  } else if ((belowSoft && deterioration) || (maBear && dayChg <= TH.formingDrop && close < ma60)) {
    stage = longDown60 ? "下行延续" : "顶部形成中";
  } else if (chg60 >= 15 && distHigh20 <= -8 && chg20 <= -3 && close < ma10) {
    // 冲高回落型：60 日先涨了一大段（有可顶之势），如今距 20 日高点回落 ≥8%、
    // 近 20 日转跌、收盘跌破 10 日线——反弹/上涨在高位熄火（2026-10-23 回算九牧王补入）
    stage = "顶部形成中";
  } else if (dayChg <= TH.pullbackDrop && distMA60 >= TH.pullbackAboveMA) {
    stage = "趋势内回撤";
  } else {
    stage = "趋势健康";
  }

  return {
    direction,
    stage,
    close: r2(close),
    dayChg: r1(dayChg),
    chg20: r1(chg20),
    chg60: r1(chg60),
    distMA60: r1(distMA60),
    distHigh20: r1(distHigh20),
    maStruct: maBull ? "多头排列" : maBear ? "空头排列" : "均线纠缠",
    ma: { 5: r2(ma5), 10: r2(ma10), 20: r2(ma20), 60: r2(ma60) },
    distHigh250: r1(distHigh250),
    volRatio: volRatio == null ? null : r2(volRatio),
    chg5: r1(chg5),
    bars: n,
    asOf: bars[n - 1].tradeDate,
  };
}

const pct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v}%`);

/** 表格短标签：上升·趋势健康 / 下跌·下行延续 … */
export function trendShortLabel(t) {
  if (!t) return "数据不足";
  return `${t.direction}·${t.stage}`;
}

/** 正文人话一行（带证据） */
export function trendLine(t) {
  if (!t) return "趋势阶段（MyDesk 判定）：日K数据不足，未判定。";
  const bits = [
    `收盘 ${t.close} 元`,
    t.distMA60 >= 0 ? `在 60 日线之上（高 ${t.distMA60}%）` : `在 60 日线之下（低 ${Math.abs(t.distMA60)}%）`,
    `近 60 日${t.chg60 >= 0 ? "涨" : "跌"} ${Math.abs(t.chg60)}%`,
    t.maStruct === "均线纠缠" ? "均线纠缠" : `均线${t.maStruct}`,
  ];
  if (t.distHigh250 != null && t.distHigh250 <= -40) {
    bits.push(`大周期仍属跌后修复（距一年高点 ${t.distHigh250}%）`);
  }
  if (t.volRatio != null && t.volRatio >= 1.3 && t.chg5 < 0) {
    bits.push(`近 5 日放量下跌（量为 20 日均量的 ${t.volRatio} 倍）`);
  } else if (t.volRatio != null && t.volRatio >= 1.3 && t.chg5 > 0) {
    bits.push(`近 5 日放量上涨（量为 20 日均量的 ${t.volRatio} 倍）`);
  }
  return `趋势阶段（MyDesk 按决策日收盘判定）：${t.direction}趋势 · ${t.stage}。${bits.join("；")}。`;
}
