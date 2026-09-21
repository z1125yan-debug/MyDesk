// 新浪个股资金流备胎的纯解析核（东财 push2his fflow 断源时补个股主力净额）
//
// 背景：2026-09-22 东财 push2/push2his 对本机出口断连，且实测走代理同样被拒（域名级风控，换 IP 无用），
// 个股级主力净额（fetchDetailReal 的近 14 日序列）整条链路只能返回 null。
// 端点移植自开源仓库 simonlin1212/a-stock-data（Apache-2.0）的 fund_flow_backup()，
// 接入前实测直连返回真实数据（600519 最新到 2026-09-21 收盘）。它不封 IP、用现成 UA 即通。
//
// 抄过来的两条实测坑（见 SKILL.md「备用源速查」）：
//  1) 920xxx 是北交所：前缀必须先判「92」再判「6/9」，判成 sh/sz 时新浪返回空数组——空数组在
//     这条链路上会被上层当成「该股票没有资金流数据」，比报错更难被发现；
//  2) 口径：netamount 是新浪的日度净额（≈主力净流入，元），与东财 f62「主力净额」不完全等价——
//     所以 DetailReal 带 source 出身标记，每个消费处都必须如实标「新浪口径」，不许冒充东财读数。
// 本文件零 IO：fetch 与缓存都留在 em.ts 服务层，这里只管认代码、拼 URL、拆数据。

export interface SinaFlowDay {
  date: string;   // YYYY-MM-DD（opendate）
  netYi: number;  // 主力净额（亿元，由 netamount 元 ÷1e8 换算）
}

/** 6 位代码 → 新浪带市场前缀的代码；认不出形状返回 null（板块码 BK/指数不许硬凑一个前缀去查） */
export function sinaCodeOf(code6: string): string | null {
  if (!/^\d{6}$/.test(code6)) return null;
  // 92 先判：920xxx 是北交所（误判成 sh/sz 时新浪返回空数组，不是报错）
  if (code6.startsWith("92") || code6.startsWith("8")) return `bj${code6}`;
  if (code6.startsWith("6") || code6.startsWith("9")) return `sh${code6}`;
  return `sz${code6}`; // 0/3 开头深市
}

/** 个股资金流历史列表（按日、倒序请求）；days 夹在 1..180，代码认不出返回 null */
export function sinaFundFlowUrl(code6: string, days: number): string | null {
  const pre = sinaCodeOf(code6);
  if (!pre) return null;
  const num = Math.min(180, Math.max(1, Math.trunc(days) || 1));
  return `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/`
    + `MoneyFlow.ssl_qsfx_zjlrqs?page=1&num=${num}&sort=opendate&asc=0&daima=${pre}`;
}

/**
 * 解析新浪返回的记录数组（已 JSON.parse 的 payload；字段是字符串数字）。
 * 任何一条缺日期形状或净额不是有限数就整条跳过——不补 0、不拿邻近日顶。
 * 输出按日期升序：与东财 fflow klines 同向，消费处（days.at(-1)=今日、连流入倒着数）零改动。
 */
export function parseSinaFundFlow(payload: unknown): SinaFlowDay[] {
  if (!Array.isArray(payload)) return [];
  const out: SinaFlowDay[] = [];
  for (const row of payload as Record<string, unknown>[]) {
    if (!row || typeof row !== "object") continue;
    const date = typeof row.opendate === "string" ? row.opendate.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const raw = row.netamount;
    const net = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
    if (!Number.isFinite(net)) continue;
    out.push({ date, netYi: net / 1e8 });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}
