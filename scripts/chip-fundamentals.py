#!/usr/bin/env python3
"""
筹码分布 + 基本面数据助手（a-stock-data 方案）
- 筹码分布：a-stock-data §4.6 本地计算（OHLC + 换手率 → 获利比例/平均成本/成本区间/筹码峰）
- 基本面：baostock 日频 PE/PB（a-stock-data §6.5 估值历史思路）

用法：python3 chip-fundamentals.py 600893 002332
输出：JSON {code: {chip: {...}, fundamentals: {...}, error: ...}}

数据纪律：取不到就返回 error，不编造。baostock 免费无需 key。
"""
import sys
import json
import numpy as np
import pandas as pd

try:
    import baostock as bs
except ImportError:
    print(json.dumps({"error": "baostock not installed"}))
    sys.exit(1)


def bs_code(code6):
    """6位代码 → baostock 代码"""
    if code6.startswith("6") or code6.startswith("9"):
        return f"sh.{code6}"
    elif code6.startswith("0") or code6.startswith("3"):
        return f"sz.{code6}"
    elif code6.startswith("8") or code6.startswith("92"):
        return f"bj.{code6}"
    return None


def _triangular_weights(grid, low, high, avg):
    """当日筹码在价格网格上的三角分布权重（a-stock-data §4.6 原样）"""
    w = np.zeros_like(grid)
    if not np.isfinite([low, high, avg]).all() or high < low:
        return w
    if high - low < 1e-9:
        w[np.argmin(np.abs(grid - low))] = 1.0
        return w
    avg = min(max(avg, low), high)
    left = (grid >= low) & (grid <= avg)
    right = (grid > avg) & (grid <= high)
    if avg - low > 1e-9:
        w[left] = (grid[left] - low) / (avg - low)
    else:
        w[left] = 1.0
    if high - avg > 1e-9:
        w[right] = (high - grid[right]) / (high - avg)
    else:
        w[right] = 1.0
    total = w.sum()
    if total > 0:
        return w / total
    w[np.argmin(np.abs(grid - avg))] = 1.0
    return w


def chip_distribution(df, grid_size=300, decay=1.0):
    """筹码分布 — a-stock-data §4.6 原样移植"""
    need = {"date", "high", "low", "close", "turn"}
    missing = need - set(df.columns)
    if missing:
        raise ValueError(f"缺少列: {sorted(missing)}")
    d = df.dropna(subset=["high", "low", "close", "turn"]).copy()
    d = d[d["high"] > 0]
    if d.empty:
        raise ValueError("有效行数为 0")
    d = d.sort_values("date").reset_index(drop=True)

    lo, hi = float(d["low"].min()), float(d["high"].max())
    pad = (hi - lo) * 0.02 or max(lo * 0.02, 0.01)
    grid = np.linspace(lo - pad, hi + pad, grid_size)

    chips = None
    for row in d.itertuples(index=False):
        t = float(row.turn) / 100.0 * decay
        t = min(max(t, 0.0), 1.0)
        avg = (float(row.high) + float(row.low) + float(row.close)) / 3.0
        w = _triangular_weights(grid, float(row.low), float(row.high), avg)
        if w.sum() <= 0:
            continue
        if chips is None:
            chips = w.copy()
            continue
        chips = chips * (1.0 - t) + w * t
    if chips is None:
        raise RuntimeError("无法构建分布")

    total = chips.sum()
    if total <= 0:
        raise RuntimeError("筹码总量为 0")
    chips = chips / total

    price = float(d["close"].iloc[-1])
    cum = np.cumsum(chips)

    def price_at(q):
        return float(np.interp(q, cum, grid))

    p05, p15, p85, p95 = (price_at(q) for q in (0.05, 0.15, 0.85, 0.95))
    peak_i = int(np.argmax(chips))
    return {
        "price": price,
        "profit_ratio": float(chips[grid <= price].sum()),
        "avg_cost": float((grid * chips).sum()),
        "cost_90": [p05, p95],
        "cost_70": [p15, p85],
        "concentration_90": float((p95 - p05) / (p95 + p05)) if p95 + p05 else None,
        "concentration_70": float((p85 - p15) / (p85 + p15)) if p85 + p15 else None,
        "peak_price": float(grid[peak_i]),
        "trading_days": len(d),
    }


def get_chip_and_fundamentals(code6, days=250):
    """取一只股票的筹码分布 + 基本面"""
    bsc = bs_code(code6)
    if not bsc:
        return {"error": f"无法识别代码 {code6}"}

    lg = bs.login()
    if lg.error_code != "0":
        return {"error": f"baostock 登录失败: {lg.error_msg}"}

    try:
        # 取 OHLC + 换手率 + PE/PB（近 days 个交易日）
        rs = bs.query_history_k_data_plus(
            bsc,
            "date,open,high,low,close,turn,peTTM,pbMRQ",
            start_date="2024-01-01",
            frequency="d",
            adjustflag="2",  # 前复权，筹码成本必须用复权价
        )
        if rs.error_code != "0":
            return {"error": f"baostock 查询失败: {rs.error_msg}"}

        rows = []
        while (rs.error_code == "0") & rs.next():
            rows.append(rs.get_row_data())

        if not rows:
            return {"error": "baostock 返回空数据"}

        df = pd.DataFrame(rows, columns=rs.fields)
        for c in ["open", "high", "low", "close", "turn", "peTTM", "pbMRQ"]:
            df[c] = pd.to_numeric(df[c], errors="coerce")

        # 停牌日（turn 为 0 或 NaN）不参与筹码计算
        df_clean = df[df["turn"] > 0].copy()
        if len(df_clean) < 20:
            return {"error": f"有效交易日不足 ({len(df_clean)} < 20)"}

        # 取最近 days 天
        df_clean = df_clean.tail(days)

        result = {}

        # 筹码分布
        try:
            chip = chip_distribution(df_clean[["date", "high", "low", "close", "turn"]])
            result["chip"] = chip
        except Exception as e:
            result["chip"] = {"error": str(e)}

        # 基本面（最新 PE/PB + 历史分位）
        try:
            df_valid = df_clean[df_clean["peTTM"] > 0].copy()
            if len(df_valid) > 0:
                latest_pe = float(df_valid["peTTM"].iloc[-1])
                latest_pb = float(df_valid["pbMRQ"].iloc[-1])
                # PE 历史分位（近1年）
                pe_hist = df_valid["peTTM"].tail(250)
                pe_percentile = float((pe_hist < latest_pe).mean() * 100)
                result["fundamentals"] = {
                    "pe_ttm": round(latest_pe, 2),
                    "pb": round(latest_pb, 2),
                    "pe_percentile_1y": round(pe_percentile, 1),
                    "pe_percentile_note": f"当前PE在近1年{pe_percentile:.0f}%分位",
                    "data_days": len(df_valid),
                }
            else:
                result["fundamentals"] = {"error": "无有效PE数据"}
        except Exception as e:
            result["fundamentals"] = {"error": str(e)}

        return result

    finally:
        bs.logout()


def main():
    codes = sys.argv[1:]
    if not codes:
        print(json.dumps({"error": "请传入股票代码"}))
        sys.exit(1)

    out = {}
    for code in codes:
        code = code.strip()
        if not code.isdigit() or len(code) != 6:
            out[code] = {"error": "代码格式错误"}
            continue
        try:
            out[code] = get_chip_and_fundamentals(code)
        except Exception as e:
            out[code] = {"error": f"异常: {str(e)}"}

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
