// 链研究补数层的「代表个股速览」（纯核，2026-09-29）。
//
// 为什么要有它：链研究轮次会给代表个股补 15 份数据（最多 3 只 × 行情/技术/五档/主营/消息），
// 注入块实测量级 15.6k 字；模型会漏读后面的块——同一段提示词、同一个问题，连问四次只有一次
// 把「技术」读数用上（另三次把技术/消息/基本面写成「暂无数据」，数据其实都在块里）。
// 数据不缺，缺的是**可读性**：这里把 15 份原始结果压成「一只票一行」的速览放在注入块最前面，
// 让模型第一眼就看见本轮已经拿到了什么。
//
// 纯函数：只吃前面几棒的原始结果，不取数、不 import 服务层（可 node --test 直跑）。
// 口径纪律：每个字段都直接抄自某一份工具结果，缺就写「缺」，**不跨字段推算**
// （不拿涨跌幅推资金方向、不拿消息推主营、不拿板块财务量级推个股）。
// （本模块零依赖：不 import 服务层、不 import 量化取数层，可 node --test 直跑。）

type Raw = { tool: string; out: unknown };

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function txt(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function cut(s: string | null, n: number): string | null {
  if (!s) return null;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
const f2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);

/** 带符号的百分比文本（+4.42% / -9.03%） */
function pct(v: number | null): string | null {
  return v == null ? null : `${v > 0 ? "+" : ""}${f2(v)}%`;
}

/** 链上位置：板块 → 产业链节点，渲染成「AI算力域 · 中游：PCB/CCL」 */
function chainPosText(v: unknown): string | null {
  if (typeof v === "string") return txt(v);
  const o = asObj(v);
  if (!o) return null;
  const dom = txt(o.domain);
  const bits: string[] = [];
  for (const layer of ["上游", "中游", "下游"]) {
    const arr = Array.isArray(o[layer]) ? (o[layer] as unknown[]) : [];
    const names = arr.map(asObj).map((x) => txt(x?.节点)).filter((s): s is string => !!s);
    if (names.length) bits.push(`${layer}：${names.join("/")}`);
  }
  if (!bits.length) return dom ? `${dom}域` : null;
  return `${dom ? `${dom}域 · ` : ""}${bits.join(" · ")}`;
}

/**
 * 板块段：把成分股那一块顺带带出的板块级读数（整体市值 / 链上位置 / 板块财务）+ 资金榜读数压成一行。
 *
 * 为什么也放进置顶速览：真机 D 跑（22836.84 亿元进了注入块）模型答对了，之后三连问又全部没提「板块整体市值」
 * ——它埋在 15 份结果的中段。用户点名要看的这几项（板块整体市值 / 板块内 AI 相关子行业 / 板块财务）
 * 必须和代表个股一样第一眼可见。没有成分股那一块时返回 null（调用方不注入空段）。
 */
function buildBoardLine(rounds: Raw[]): string | null {
  const cons = asObj(rounds.find((r) => r.tool === "sector_constituents")?.out);
  if (!cons) return null;
  const name = txt(cons.板块名) ?? txt(cons.board_code);
  if (!name) return null;
  const seg: string[] = [`板块 ${name}`];

  // 资金榜读数：同花顺兜底榜没有东财代码，只能按板块名对行（对不上就不写，不拿别的行顶）
  const rank = asObj(rounds.find((r) => r.tool === "sector_rank")?.out);
  const rows = Array.isArray(rank?.板块) ? (rank!.板块 as unknown[]) : [];
  const row = rows.map(asObj).find((x) => x && (txt(x.名称) === name || txt(x.板块) === name)) ?? null;
  if (row) {
    const bits: string[] = [];
    const rk = num(row.排名);
    if (rk != null) bits.push(`${txt(rank?.数据源)?.startsWith("同花顺") ? "同花顺资金榜" : "东财资金榜"}第 ${rk} 名`);
    const net = f2(num(row.主力净额亿));
    if (net != null) bits.push(`主力净额 ${net}亿`);
    const chg = pct(num(row.涨跌幅));
    if (chg) bits.push(`板块涨跌幅 ${chg}`);
    const leader = txt(row.领涨股);
    if (leader) bits.push(`领涨 ${leader}`);
    if (bits.length) seg.push(`资金：${bits.join(" · ")}`);
  }

  const cap = f2(num(cons.板块整体市值亿));
  if (cap != null) seg.push(`板块整体市值 ${cap} 亿元`);
  const capBasis = txt(cons.板块整体市值口径);
  if (cap != null && capBasis) seg.push(`（${capBasis}）`);

  const pos = chainPosText(cons.链上位置);
  if (pos) seg.push(`产业链归属：${pos}`);
  else if (typeof cons.链上位置 === "string" && txt(cons.链上位置)) seg.push(`产业链归属：${txt(cons.链上位置)}`);

  const fund = asObj(cons.板块财务分量);
  if (fund) {
    const fb: string[] = [];
    const pairs: [string, string][] = [
      ["revenue_yoy", "收入同比"],
      ["earnings_yoy", "利润同比"],
      ["orders_yoy", "订单同比"],
      ["inventory_yoy", "存货同比"],
      ["capex_yoy", "资本开支同比"],
      ["inventory_ratio_pct", "存货占比"],
    ];
    for (const [k, label] of pairs) {
      const v = num(fund[k]);
      if (v == null) continue;
      fb.push(k === "inventory_ratio_pct" ? `${label} ${f2(v)}%` : `${label} ${pct(v)}`);
    }
    const asOf = txt(fund.earnings_period) ?? txt(fund.orders_period) ?? txt(fund.inventory_period);
    if (fb.length) seg.push(`板块财务${asOf ? `（截至 ${asOf}）` : ""}：${fb.join(" · ")}`);
  }

  return `- ${seg.join(" ｜ ")}`;
}

/** 均线位置：above_ma_* 的 0/1 → 「MA5 ✓ / MA20 ✗」（字段缺失的档位不写，不猜） */
function maText(tech: Record<string, unknown> | null): string | null {
  if (!tech) return null;
  const parts: string[] = [];
  for (const k of ["above_ma_5", "above_ma_10", "above_ma_20", "above_ma_60"]) {
    const v = tech[k];
    if (v == null) continue;
    const ok = v === 1 || v === true || v === "1";
    parts.push(`${k.replace("above_ma_", "MA")} ${ok ? "✓" : "✗"}`);
  }
  const struct = txt(tech.ma_struct);
  if (struct) parts.push(`多头排列=${struct}`);
  return parts.length ? parts.join(" / ") : null;
}

/**
 * 把「板块段 + 代表个股段」压成速览文本；两段都没有时返回 null（调用方据此不注入）。
 */
export function buildChainDigest(rounds: Raw[]): string | null {
  const list = Array.isArray(rounds) ? rounds : [];
  const boardLine = buildBoardLine(list);
  const syms: string[] = [];
  for (const r of list) {
    if (r?.tool !== "stock_snapshot") continue;
    const sym = txt(asObj(r.out)?.symbol);
    if (sym && !syms.includes(sym)) syms.push(sym);
  }
  if (!syms.length && !boardLine) return null;

  const pick = (tool: string, symbol: string) =>
    list.find((r) => r.tool === tool && txt(asObj(r.out)?.symbol) === symbol);

  const lines = syms.map((sym) => {
    const snap = asObj(pick("stock_snapshot", sym)?.out);
    const name = txt(snap?.名称) ?? null;
    const seg: string[] = [`- ${sym}${name ? ` ${name}` : ""}`];

    if (snap) {
      const price = num(snap.现价), chg = num(snap.涨跌幅);
      if (price != null) seg.push(`现价 ${price}${chg != null ? `（${pct(chg)}）` : ""}`);
      const amt = f2(num(snap.成交额亿)); if (amt != null) seg.push(`成交额 ${amt}亿`);
      const net = f2(num(snap.主力净额亿)); if (net != null) seg.push(`主力净额 ${net}亿`);
      const pe = f2(num(snap.市盈率TTM)); if (pe != null) seg.push(`PE ${pe}`);
      const ind = txt(snap.行业); if (ind) seg.push(`行业 ${ind}`);
    } else {
      seg.push("行情 缺");
    }

    const k = asObj(pick("stock_kline_summary", sym)?.out);
    const tech = asObj(k?.技术状态);
    const ma = maText(tech);
    const macd = tech ? f2(num(tech.macd)) : null;
    const rsi = tech ? f2(num(tech.rsi_14)) : null;
    const techBits = [ma, macd != null ? `MACD ${macd}` : null, rsi != null ? `RSI ${rsi}` : null].filter(Boolean);
    seg.push(techBits.length ? `技术：${techBits.join(" / ")}` : "技术 缺");

    const dep = asObj(pick("stock_depth", sym)?.out);
    if (dep) {
      const ratio = f2(num(dep.委买卖比));
      const b = f2(num(dep.委买总量手)), a = f2(num(dep.委卖总量手));
      seg.push(`盘口：委买卖比 ${ratio ?? "—"}（委买 ${b ?? "—"} 手 / 委卖 ${a ?? "—"} 手）`);
    } else {
      seg.push("盘口 缺");
    }

    const biz = asObj(pick("stock_business_composition", sym)?.out);
    const mainBiz = cut(txt(biz?.主营业务), 60);
    seg.push(mainBiz ? `主营「${mainBiz}」` : "主营 缺");

    const newsOut = asObj(pick("stock_news", sym)?.out);
    const n0 = Array.isArray(newsOut?.新闻) ? asObj((newsOut!.新闻 as unknown[])[0]) : null;
    const title = cut(txt(n0?.标题), 46);
    const nTime = txt(n0?.时间);
    const annN = Array.isArray(newsOut?.公告) ? (newsOut!.公告 as unknown[]).length : 0;
    if (title) seg.push(`消息「${title}」${nTime ? `（${nTime}）` : ""}${annN ? `，另有 ${annN} 条公告` : ""}`);
    else if (newsOut) seg.push(`消息 本轮没搜到相关报道${annN ? `（另有 ${annN} 条公告）` : ""}`);
    else seg.push("消息 缺");

    return seg.join(" ｜ ");
  });

  const out: string[] = ["[链研究速览（本轮已取到，放最前面免得漏读；这里没写的维度就不许当数据用）]"];
  if (boardLine) out.push("【板块段】", boardLine);
  if (lines.length) out.push("【代表个股段】", ...lines);
  return out.join("\n");
}
