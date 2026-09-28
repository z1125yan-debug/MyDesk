"""国庆日历效应复算：用 akshare 上证指数全量日线，复现中信建投研报口径。

口径（对齐中信建投证券 2026-09-28 东方财富文引用的「2016年以来剔除2018/2024」）：
- 国庆前一周：国庆前最后一个交易日（国庆前一日，T）及其往前 4 个交易日，共 5 个交易日；
  收益 = close(T) / close(T-5) - 1（T-5 为 T 往前第 5 个交易日）。
- 国庆后一周：国庆后首个交易日（T+1，通常 10/8）及其往后 4 个交易日，共 5 个交易日；
  收益 = close(T+5) / close(T) - 1。
- 样本年：2016..2025（共 10 年）。另给「剔除 2018、2024」子样本（中信建投原文剔除这两个大波动年）。

输出：每年明细 + 全样本/剔除样本 的「下跌(或上涨)概率、平均涨跌幅」，
并对照中信建投公布的 87.5%/1.1%（前）、62.5%/1.3%（后）。
"""
import json
import sys
import os
from datetime import date

import akshare as ak

START_YEAR, END_YEAR = 2016, 2025
EXCLUDE = {2018, 2024}  # 中信建投原文剔除的两个大波动年
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "data", "calendar-effect-national-day.json")

CICC_PRE = (0.875, -0.011)   # 中信建投：前一周 下跌概率 87.5% / 平均跌 1.1%
CICC_POST = (0.625, 0.013)   # 中信建投：后一周 上涨概率 62.5% / 平均涨 1.3%


def fetch_index_daily():
    """优先新浪源（本机出口 IP 对东财 push2 集群拒连，已实测）；失败回退腾讯源。"""
    # 新浪：stock_zh_index_daily(symbol="sh000001") -> date/open/close/high/low/volume
    try:
        df = ak.stock_zh_index_daily(symbol="sh000001")
        src = "akshare.stock_zh_index_daily(symbol='sh000001') 新浪"
    except Exception as e:
        print(f"[warn] 新浪源失败: {e}，回退腾讯源", file=sys.stderr)
        df = ak.stock_zh_index_daily_tx(symbol="sh000001")
        src = "akshare.stock_zh_index_daily_tx(symbol='sh000001') 腾讯"
    df = df[df["date"].astype(str) >= f"{START_YEAR}-01-01"]
    df = df[df["date"].astype(str) <= "2025-12-31"]
    rows = [(str(r["date"]), float(r["close"])) for _, r in df.iterrows()]
    return rows, src


def main():
    rows, src = fetch_index_daily()
    rows.sort(key=lambda x: x[0])
    dates = [r[0] for r in rows]
    close = {d: c for d, c in rows}
    # 交易日序列（指数有行的日期即交易日）
    tdset = set(dates)
    tdlist = dates  # 已按日期升序

    def prev_n_td(d, n):
        # 返回 d 之前第 n 个交易日（不含 d）
        i = tdlist.index(d)
        return tdlist[i - n] if i - n >= 0 else None

    def next_n_td(d, n):
        i = tdlist.index(d)
        return tdlist[i + n] if i + n < len(tdlist) else None

    def last_td_before(oct1):
        # 国庆前最后一个交易日
        cand = [d for d in tdlist if d < oct1]
        return cand[-1] if cand else None

    def first_td_on_after(oct8):
        for d in tdlist:
            if d >= oct8:
                return d
        return None

    table = []
    for y in range(START_YEAR, END_YEAR + 1):
        oct1 = f"{y}-10-01"
        oct8 = f"{y}-10-08"
        if oct1 not in tdset and y >= 2026:
            continue
        last_pre = last_td_before(oct1)        # T
        resume = first_td_on_after(oct8)        # T+1
        if not last_pre or not resume:
            continue
        t5 = prev_n_td(last_pre, 5)             # T-5
        t_plus5 = next_n_td(resume, 4)          # T+5（resume 往后 4 个交易日，含 resume 共 5 个）
        if not t5 or not t_plus5:
            continue
        pre_ret = close[last_pre] / close[t5] - 1.0
        post_ret = close[t_plus5] / close[last_pre] - 1.0
        table.append({
            "year": y, "last_pre": last_pre, "resume": resume,
            "pre5_start": t5, "post5_end": t_plus5,
            "pre_return": round(pre_ret, 4), "post_return": round(post_ret, 4),
            "excluded": y in EXCLUDE,
        })

    def summarize(subset):
        n = len(subset)
        if not n:
            return None
        pre_down = sum(1 for x in subset if x["pre_return"] < 0)
        post_up = sum(1 for x in subset if x["post_return"] > 0)
        pre_avg = sum(x["pre_return"] for x in subset) / n
        post_avg = sum(x["post_return"] for x in subset) / n
        return {
            "n": n,
            "pre_down_prob": round(pre_down / n, 4),
            "pre_avg_return": round(pre_avg, 4),
            "post_up_prob": round(post_up / n, 4),
            "post_avg_return": round(post_avg, 4),
        }

    full = summarize(table)
    trimmed = summarize([x for x in table if not x["excluded"]])

    out = {
        "source": src,
        "method": "国庆前一周=节前最后交易日及往前4交易日(close(T)/close(T-5)-1)；"
                  "后一周=节后首个交易日及往后4交易日(close(T+5)/close(T)-1)",
        "exclude_years": sorted(EXCLUDE),
        "citic_reference": {"pre_down_prob": CICC_PRE[0], "pre_avg_return": CICC_PRE[1],
                             "post_up_prob": CICC_POST[0], "post_avg_return": CICC_POST[1]},
        "per_year": table,
        "summary_full": full,
        "summary_trimmed": trimmed,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    # 打印对照
    print(f"样本年数(全): {full['n']}  剔除后: {trimmed['n']}")
    print(f"{'年':>5} {'节前最后':<12} {'节后首':<12} {'前周收益':>9} {'后周收益':>9} {'剔除':>4}")
    for x in table:
        print(f"{x['year']:>5} {x['last_pre']:<12} {x['resume']:<12} "
              f"{x['pre_return']*100:>8.2f}% {x['post_return']*100:>8.2f}% {'是' if x['excluded'] else '':>4}")
    print("\n=== 全样本(2016-2025) ===")
    print(f"前一周下跌概率 {full['pre_down_prob']*100:.1f}% (中信建投参考 87.5%) | 平均 {full['pre_avg_return']*100:+.2f}% (参考 -1.1%)")
    print(f"后一周上涨概率 {full['post_up_prob']*100:.1f}% (中信建投参考 62.5%) | 平均 {full['post_avg_return']*100:+.2f}% (参考 +1.3%)")
    print("\n=== 剔除2018/2024 ===")
    print(f"前一周下跌概率 {trimmed['pre_down_prob']*100:.1f}% | 平均 {trimmed['pre_avg_return']*100:+.2f}%")
    print(f"后一周上涨概率 {trimmed['post_up_prob']*100:.1f}% | 平均 {trimmed['post_avg_return']*100:+.2f}%")
    print(f"\n已写出: {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
