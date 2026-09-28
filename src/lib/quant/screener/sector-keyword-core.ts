// 板块/概念搜索关键词规整 · 纯核（客户端可安全 import：不碰 fs / path / window）。
//
// 为什么单开一个 core 文件：规整规则同时被**服务端**（选股引擎跑条件时若要规整）与**客户端**
// （板块页递棒 → 选股页消费 `?sector=` 时预置条件）用到。种子加载器 `data/rps-seed.ts` 依赖
// Node 的 fs/path，客户端 import 它会直接把 `fs` 打进浏览器包（Next 报 "Can't resolve 'fs'"），
// 故把这条与文件系统无关的纯规则抽到这里，两端都从这里取。
//
// 口径来源（逐字照搬，源码实证）：稳智选股页 `StockScreener-D3IX2PmW.js`：
//   if(y.query.sector){ const i=(d=>{ ... })(e)||e; push({field:"sector|concept",op:"like",value:i}) }

/**
 * 对齐稳智选股页对 `?sector=<名>` 参数的规整。稳智点板块名跳选股页时传的是**原始板块名**，
 * 选股页在消费时把它规整成搜索关键词，规则逐字照搬：
 *   1) 去首尾空白；空 → 返回空串（选股页据此不加条件）；
 *   2) 含「·」→ 原样返回（复合名，如 "银行·股份制银行"）；
 *   3) 否则取**最长的字母数字段**，长度 ≥3 → 用它（如 "CPO概念" → "CPO"）；
 *   4) 否则去掉空白/标点，再去掉结尾的 (指数|板块|概念|产业链|主题)；
 *   5) 去掉后长度 ≥4 → 再砍掉**最后一个字**（稳智原样行为，如 "人工智能" → "人工智"）；
 *   6) 规整结果为空 → 回退原始入参（稳智的 `|| e`）。
 */
export function normalizeSectorKeyword(raw: string): string {
  const g = (raw ?? "").trim();
  if (!g) return "";
  if (g.includes("·")) return g;
  const seg = (g.match(/[A-Za-z0-9]+/g) ?? []).sort((a, b) => b.length - a.length)[0];
  if (seg && seg.length >= 3) return seg;
  const n = g
    .replace(/[\s·•・，,。；;、()（）【】\[\]『』《》<>]/g, "")
    .replace(/(指数|板块|概念|产业链|主题)$/, "");
  const out = n.length >= 4 ? n.slice(0, n.length - 1) : n;
  return out || raw;
}
