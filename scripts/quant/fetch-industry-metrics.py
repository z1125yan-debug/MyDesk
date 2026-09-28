#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase2 产业链真实指标接入（v2）：只写 data/sector-industry-map.json 的 metricSnapshots。
严格遵循原则：不制造代理数据、拿不到真实数据保持 null、不碰引擎、不扫参。

本脚本只接入「上游节点有真实可交易商品代表品」的 price_trend：
  - 拉 akshare 期货日线 -> 聚合成月均价 -> 每月一条 snapshot
  - 只填 price_trend（每个 snapshot 额外带 value/source/metric/frequency/unit 以溯源）
  - 其余字段 orders_z / inventory_state / earnings_z / capex_state 保持 null

未接入字段（诚实保持 null，由引擎降权）：
  - orders_z / inventory_state：国家统计局 PMI 分项（新订单/原材料库存/产成品库存/在手订单）
      真实结构化源在本沙箱不可达（akshare 无分项；东方财富 reportName 无；stats.gov.cn easyquery 403）。
  - earnings_z：工业企业利润全国月度真实源未找到稳定接口（东方财富 reportName 试错未命中）。
  - capex_state：资本开支季度真实源免费不可用。
  - PPI / 工业增加值：属"全国宏观代理"，不在本 schema 单节点填（避免用全国数据伪装单行业）。

用法：python3 scripts/quant/fetch-industry-metrics.py
"""
import json
import akshare as ak

MAP_PATH = "data/sector-industry-map.json"

# nodeId -> (期货主力代码, 代表品名, 单位, 诚实备注)
NODE_SYMBOL = {
    "mt_cu":          ("cu0", "沪铜",        "元/吨", "真实铜期货月均价"),
    "mt_al":          ("al0", "沪铝",        "元/吨", "真实铝期货月均价"),
    "mt_gold":        ("au0", "沪金",        "元/克", "真实黄金期货月均价"),
    "ne_lithium":     ("lc0", "碳酸锂(锂盐)", "元/吨", "真实碳酸锂期货月均价"),
    "ne_polysilicon": ("ps0", "多晶硅(硅料)", "元/吨", "真实多晶硅期货月均价"),
    "re_material":    ("rb0", "螺纹钢(钢/建材)", "元/吨", "真实螺纹钢期货月均价"),
    "mt_energy":      ("ni0", "沪镍(能源金属=锂钴镍)", "元/吨", "真实镍期货月均价"),
    # ch_basic 用原油作基础化工能源成本代理（非化工品本身，如实标注），用户点名要接原油
    "ch_basic":       ("sc0", "原油(基础化工能源成本代理)", "元/桶", "真实原油期货月均价，作基础化工上游能源成本代理"),
    # 2026-09-29 扩容：产品本身的期货（非代理，品种即行业产品）
    "ch_fiber":       ("pf0", "涤纶短纤(化纤)", "元/吨", "真实短纤期货月均价，涤纶短纤即化纤类产品"),
    "ch_agro":        ("ur0", "尿素(农化)",   "元/吨", "真实尿素期货月均价，尿素即化肥类产品"),
    "ch_plastic":     ("L0",  "聚乙烯(塑料)", "元/吨", "真实聚乙烯期货月均价，交易代码即『塑料』"),
}


def monthly_avg(symbol: str) -> dict:
    """拉期货日线，按 YYYY-MM 聚合成月均价。保留原始月度均值作为 value。"""
    df = ak.futures_zh_daily_sina(symbol=symbol)
    df = df.dropna(subset=["close"])
    buckets: dict[str, list[float]] = {}
    for _, r in df.iterrows():
        ym = str(r["date"])[:7]
        try:
            buckets.setdefault(ym, []).append(float(r["close"]))
        except (TypeError, ValueError):
            continue
    return {ym: round(sum(v) / len(v), 2) for ym, v in buckets.items() if v}


def main() -> None:
    with open(MAP_PATH, encoding="utf-8") as f:
        m = json.load(f)
    ms = m.setdefault("metricSnapshots", {})

    summary: dict[str, tuple] = {}
    for node_id, (sym, name, unit, note) in NODE_SYMBOL.items():
        try:
            mv = monthly_avg(sym)
            if not mv:
                summary[node_id] = (name, "EMPTY", None)
                continue
            snaps = [
                {
                    "date": ym,
                    "price_trend": val,
                    "value": val,
                    "source": f"akshare.futures_zh_daily_sina(symbol={sym})",
                    "metric": "price_trend",
                    "frequency": "M",
                    "unit": unit,
                    "proxy_note": note,
                }
                for ym, val in sorted(mv.items())
            ]
            ms[node_id] = snaps
            summary[node_id] = (name, len(snaps), snaps[-1]["date"], snaps[-1]["price_trend"])
        except Exception as e:
            summary[node_id] = (name, "FAIL", str(e)[:60])

    with open(MAP_PATH, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)

    covered = [k for k, v in summary.items() if len(v) == 4]
    print("=== Phase2 上游商品价格 price_trend 接入结果 ===")
    for k, v in summary.items():
        print(f"  {k:18s} {v}")
    print(f"COVERED_NODES = {len(covered)} / {len(NODE_SYMBOL)}")
    print("未接入字段(诚实 null): orders_z, inventory_state, earnings_z, capex_state")


if __name__ == "__main__":
    main()
