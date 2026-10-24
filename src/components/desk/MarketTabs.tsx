"use client";
// 行情市场选项卡：A股 | 港股 | 美股（用户截图同款三段式）。
// 状态放 store（marketTab），全A列表 / 数据看板 / 个股行情 / 个股画像四页共用，刷新后停在上次选的市场。
// 口径纪律：A股用 A 股逻辑（通达信+本地库+财联社）；港股/美股不用 A 股的宽度/涨跌停逻辑
// （美股无涨跌停；港股/美股宽度只统计主流票，不代表全市场），各页在非 A 股时如实标注来源与缺口。
import { useDesk } from "@/lib/desk/store";

export type MarketTab = "A" | "HK" | "US";

export const MARKET_TABS: { key: MarketTab; label: string }[] = [
  { key: "A", label: "A股" },
  { key: "HK", label: "港股" },
  { key: "US", label: "美股" },
];

export default function MarketTabs() {
  const marketTab = useDesk((s) => s.marketTab);
  const setMarketTab = useDesk((s) => s.setMarketTab);
  return (
    <div className="flex rounded-lg border border-border bg-overlay/40 p-0.5 text-xs" role="tablist" aria-label="市场">
      {MARKET_TABS.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={marketTab === t.key}
          onClick={() => setMarketTab(t.key)}
          className={
            "rounded-md px-3.5 py-1.5 transition-all duration-200 " +
            (marketTab === t.key ? "bg-sky-500/20 font-medium text-sky-300" : "text-muted-foreground hover:text-foreground")
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
