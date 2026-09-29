// 代码显示口径（纯函数，前后端都能用）。
//
// 需求（2026-09-29 用户指示）：**统一改成通达信那样的——不带 .SH/.SZ/.BJ 后缀**。
// 数据层不变：`symbol` 仍带后缀（接口参数、板块成分映射、工具调用、自选存取全按带后缀查），
// 这里只负责「给人看的那一行」——显示 6 位数字，交易所信息需要时放 title。

/** 通达信口径显示码：剥掉交易所后缀（.SH/.SZ/.BJ，大小写不敏感），其余形态原样返回 */
export function plainCode(symbol: unknown): string {
  const s = String(symbol ?? "").trim();
  if (!s) return "";
  return s.replace(/\.(SH|SZ|BJ)$/i, "");
}

/**
 * 悬停提示：保留带后缀的全码，让用户需要时还能看到交易所归属。
 * 已经是纯 6 位（或非个股代码，如板块 BK0493）时返回空串——没有额外信息就不弹提示。
 */
export function codeTitle(symbol: unknown): string | undefined {
  const s = String(symbol ?? "").trim();
  const p = plainCode(s);
  if (!p || p === s) return undefined;
  return `${p}（数据层全码 ${s}）`;
}
