// GET /api/market/risk — 风险监控（P2-1）
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { computeSentiment } from "@/lib/quant/screener/sentiment";
import { fetchBarsHybrid } from "@/lib/quant/data/hybrid";
import { similarReturnForward } from "@/lib/quant/screener/similar-env";
import { shanghaiDate } from "@/lib/desk/session";
// R20：全 A 快照不带 mainNet，这里另挂一份通达信逐笔自算的主力净额合计
import { marketMainNetTdx } from "@/lib/desk/fund-flow";
// R20：接力（晋级率）/ 梯队断层 / 昨日涨停股今日表现 —— 读本地涨停名单表，判定口径在纯核里
import { readPromotionBlock, type PromotionRead } from "@/lib/quant/screener/limit-up-roster";
import { ttlCache, DEFAULT_TTL_MS } from "@/lib/quant/server-cache";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SUGGEST: Record<string, string[]> = {
  正常: ["市场可用指标未突破阈值", "仍需结合个股资金与主线结构，不构成操作建议"],
  注意: ["关注追高风险与个别情绪指标", "仓位与板块拥挤度需单独验证"],
  偏高: ["仓位风险", "追高风险", "板块轮动风险"],
  高风险: ["系统性风险上升", "降低杠杆与拥挤主线暴露（统计提示，非买卖建议）"],
  事件风险: ["临近或正在发生映射后的宏观/产业事件", "等待资金验证，避免把新闻当涨跌成因"],
};

/**
 * 2026-09-29 菜单打开提速：冷启动实测 13 秒（= 一次全 A 情绪快照 + 相似环境检索），
 * 而「风险监控」是菜单页、会反复打开。包一层进程内 TTL 缓存（60s，与轮询同档）。
 */
export async function GET() {
  return ttlCache("market/risk", DEFAULT_TTL_MS, () => getHandler());
}
async function getHandler() {
  quantBootstrap();
  try {
    const sent = await computeSentiment();
    let history_ref: ReturnType<typeof similarReturnForward> | null = null;
    let hist_error = "";
    try {
      const barsMap = await fetchBarsHybrid(["000001.SH"], shanghaiDate(), 520);
      const bars = barsMap.get("000001.SH") ?? [];
      history_ref = similarReturnForward(bars.map((b) => ({ date: b.date, c: b.c })), 0.8);
    } catch (e) {
      hist_error = (e as Error).message;
    }

    const suggestions = SUGGEST[sent.risk.level] ?? SUGGEST.注意;
    // 名单读侧失败不能拖垮整页：读不到就整块给 null + 一句原因，页面据此显示「算不出」而不是报错页
    let promotion: PromotionRead | null = null;
    let promotion_error = "";
    try {
      promotion = await readPromotionBlock();
    } catch (e) {
      promotion_error = (e as Error).message;
    }
    return NextResponse.json({
      ok: true,
      ...sent,
      missing: [
        ...sent.missing,
        ...(promotion ? promotion.missing : [`接力/梯队：读本地涨停名单失败：${promotion_error || "无数据"}`]),
      ],
      // R20：主力净额同款补一份通达信逐笔自算（全 A 快照不带 mainNet，那一路常年是 0）
      ...(await marketMainNetTdx()),
      promotion,
      promotion_error: promotion ? "" : promotion_error,
      suggestions,
      history_ref,
      history_ref_note: history_ref
        ? "上证指数：与今日涨跌幅相差≤0.8pct 的历史交易日，随后 1/5/20 日收益统计（非策略胜率）"
        : `历史参考暂不可用：${hist_error || "无K线"}`,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
