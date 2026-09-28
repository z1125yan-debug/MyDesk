// P15-R20b 外盘与 A50 —— 取数层（仅服务端，只做「发请求 + 交纯核解析」，不判任何东西）
//
// 分工照 R20a 那条纪律：判定全在 overseas-core.ts 那份纯核里，这里失败就带回错误文本，
// 路由与页面因此不可能各自长出第二套拆法。
// 两条路上任一条挂掉都不拖垮另一条（各抓各的，missing 各说各的）。
import {
  A50_CODE, a50Url, buildOverseasSnapshot, OVERSEAS_CODES, tcOverseasUrl,
  type OverseasSnapshot,
} from "./overseas-core.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** GBK 文本：腾讯与新浪的外盘/期货都是 GBK，解错编码整屏变乱码（本项目已在 R17 踩过一次） */
async function fetchGbkText(url: string, referer: string | null, timeoutMs: number): Promise<string> {
  const headers: Record<string, string> = { "User-Agent": UA };
  // 新浪那条认 Referer：不带就是 403，带了才给数（sina-kline.ts 同款）
  if (referer) headers.Referer = referer;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return new TextDecoder("gbk").decode(buf);
}

/** 北京时间今天（YYYY-MM-DD）。纯核不看钟，日期从这里喂进去 */
function beijingToday(now: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string): string => p.find((x) => x.type === t)?.value ?? "0000";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * 取一份外盘 + A50 快照。
 * 不抛错：任何一路失败都落进 `missing`，调用方拿到的一定是一个能直接上屏的形状
 * （这条要摆在市场页上，为一路外盘失败把整页打红是本末倒置）。
 */
export async function fetchOverseas(now = new Date()): Promise<OverseasSnapshot> {
  const [tc, a50] = await Promise.all([
    fetchGbkText(tcOverseasUrl(OVERSEAS_CODES), null, 10_000).then(
      (t): { text: string | null; error: string } => (t ? { text: t, error: "" } : { text: null, error: "返回空 body" }),
      (e): { text: null; error: string } => ({ text: null, error: (e as Error).message || String(e) }),
    ),
    fetchGbkText(a50Url(A50_CODE), "https://finance.sina.com.cn", 10_000).then(
      (t): { text: string | null; error: string } => (t ? { text: t, error: "" } : { text: null, error: "返回空 body" }),
      (e): { text: null; error: string } => ({ text: null, error: (e as Error).message || String(e) }),
    ),
  ]);
  return buildOverseasSnapshot({
    tcText: tc.text,
    a50Text: a50.text,
    today: beijingToday(now),
    tcError: tc.error,
    a50Error: a50.error,
  });
}
