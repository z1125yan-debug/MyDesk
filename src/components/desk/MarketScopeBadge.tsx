// 市场口径徽章：A 股专属页面顶部的显式标注。
// 为什么需要：切市场（marketTab）只在 4 个页（全A列表/数据看板/行情/画像）生效，
// 其余页面（选股/日报/板块/看板/风险…）隐含 A 股口径——用户从港股/美股页切过去时，
// 若无标注会误以为看到的是当前市场的数。本徽章让每个 A 股页都自报口径。
export default function MarketScopeBadge({ note }: { note?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
      <span className="rounded-full border border-sky-400/40 bg-sky-400/10 px-2 py-0.5 font-medium text-sky-300">
        数据口径：A股
      </span>
      <span>数据源：通达信网关 + 本地 DB（东财/腾讯兜底）· 不含港股/美股数据{note ? ` · ${note}` : ""}</span>
    </div>
  );
}
