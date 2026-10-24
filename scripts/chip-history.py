#!/usr/bin/env python3
"""
历史换手率 + 筹码分布（走隧道代理）
- 新浪日K（成交量） + 腾讯流通市值/现价（算流通股本） → 历史换手率
- a-stock-data §4.6 本地计算 → 筹码分布

数据纪律：换手率 = 真实成交量 / 流通股本（当前股本近似，假设250天内股本稳定）；
           取不到返回 error，不编造。

用法：python3 chip-history.py 600893
输出：JSON {chip: {...}, turnover_days: N, note: ...}
"""
import sys
import json
import os
import subprocess
import numpy as np


def get_tunnel_proxy():
    https_proxy = os.environ.get("HTTPS_PROXY", "")
    if not https_proxy:
        return None
    base = https_proxy.rsplit(":", 1)[0]
    return f"{base}:3130"


def tencent_code(code6):
    if code6.startswith("6") or code6.startswith("9"):
        return f"sh{code6}"
    elif code6.startswith("0") or code6.startswith("3"):
        return f"sz{code6}"
    elif code6.startswith("8") or code6.startswith("92"):
        return f"bj{code6}"
    return None


def fetch_float_shares(code6, proxy):
    """腾讯实时行情 → 流通股本（股）"""
    tc = tencent_code(code6)
    url = f"https://qt.gtimg.cn/q={tc}"
    cmd = ["curl", "--proxy", proxy, "-s", "--max-time", "15", url]
    result = subprocess.run(cmd, capture_output=True, timeout=20)
    data = result.stdout.decode("gbk", errors="ignore").strip()
    if "=" not in data:
        return None, "腾讯返回格式异常"
    payload = data.split("=", 1)[1].strip().strip('";')
    f = payload.split("~")
    try:
        price = float(f[3]) if f[3] else 0
        circ_mkt_yi = float(f[45]) if len(f) > 45 and f[45] else 0  # 流通市值（亿）
        if price <= 0 or circ_mkt_yi <= 0:
            return None, "价格或市值无效"
        # 流通股本 = 流通市值(元) / 现价
        float_shares = circ_mkt_yi * 1e8 / price
        return float_shares, None
    except (IndexError, ValueError) as e:
        return None, f"解析失败: {e}"


def fetch_sina_kline(code6, proxy, days=250):
    """新浪日K → OHLC + 成交量（股）"""
    tc = tencent_code(code6)
    # scale=240是日K，datalen取足够多
    url = f"https://quotes.sina.cn/cn/api/openapi.php/CN_MarketDataService.getKLineData?symbol={tc}&scale=240&ma=no&datalen={days}"
    cmd = ["curl", "--proxy", proxy, "-s", "--max-time", "20", url]
    result = subprocess.run(cmd, capture_output=True, timeout=25)
    try:
        j = json.loads(result.stdout.decode("utf-8", errors="ignore"))
        data = j["result"]["data"]
        rows = []
        for d in data:
            rows.append({
                "date": d["day"],
                "open": float(d["open"]),
                "high": float(d["high"]),
                "low": float(d["low"]),
                "close": float(d["close"]),
                "volume": float(d["volume"]),  # 股
            })
        return rows, None
    except Exception as e:
        return None, f"新浪K线解析失败: {e}"


def _triangular_weights(grid, low, high, avg):
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


def chip_distribution(rows, grid_size=300):
    """rows: [{date, open, high, low, close, turn}] turn是百分数"""
    need = {"date", "high", "low", "close", "turn"}
    # 转成 DataFrame 逻辑（用 dict 列表）
    d = [r for r in rows if r["high"] > 0 and r["turn"] is not None]
    if len(d) < 20:
        raise ValueError(f"有效行不足 ({len(d)})")
    d = sorted(d, key=lambda x: x["date"])

    lo = min(r["low"] for r in d)
    hi = max(r["high"] for r in d)
    pad = (hi - lo) * 0.02 or max(lo * 0.02, 0.01)
    grid = np.linspace(lo - pad, hi + pad, grid_size)

    chips = None
    for r in d:
        t = float(r["turn"]) / 100.0
        t = min(max(t, 0.0), 1.0)
        avg = (r["high"] + r["low"] + r["close"]) / 3.0
        w = _triangular_weights(grid, r["low"], r["high"], avg)
        if w.sum() <= 0:
            continue
        if chips is None:
            chips = w.copy()
            continue
        chips = chips * (1.0 - t) + w * t
    if chips is None:
        raise RuntimeError("无法构建分布")
    chips = chips / chips.sum()

    price = d[-1]["close"]
    cum = np.cumsum(chips)

    def price_at(q):
        return float(np.interp(q, cum, grid))

    p05, p15, p85, p95 = (price_at(q) for q in (0.05, 0.15, 0.85, 0.95))
    peak_i = int(np.argmax(chips))
    return {
        "price": round(price, 2),
        "profit_ratio": round(float(chips[grid <= price].sum()) * 100, 2),
        "avg_cost": round(float((grid * chips).sum()), 2),
        "cost_90": [round(p05, 2), round(p95, 2)],
        "cost_70": [round(p15, 2), round(p85, 2)],
        "concentration_90": round(float((p95 - p05) / (p95 + p05)) * 100, 2) if p95 + p05 else None,
        "peak_price": round(float(grid[peak_i]), 2),
        "trading_days": len(d),
    }


def main():
    codes = sys.argv[1:]
    if not codes:
        print(json.dumps({"error": "请传入股票代码"}))
        sys.exit(1)

    proxy = get_tunnel_proxy()
    if not proxy:
        print(json.dumps({"error": "未找到隧道代理"}))
        sys.exit(1)

    out = {}
    for code6 in codes:
        code6 = code6.strip()
        if not code6.isdigit() or len(code6) != 6:
            out[code6] = {"error": "代码格式错误"}
            continue
        try:
            # 1. 流通股本
            float_shares, err = fetch_float_shares(code6, proxy)
            if err:
                out[code6] = {"error": f"股本: {err}"}
                continue
            # 2. 日K
            rows, err = fetch_sina_kline(code6, proxy)
            if err:
                out[code6] = {"error": f"K线: {err}"}
                continue
            # 3. 算换手率
            for r in rows:
                r["turn"] = r["volume"] / float_shares * 100
            # 4. 筹码分布
            chip = chip_distribution(rows)
            chip["note"] = "换手率=新浪成交量/腾讯流通股本（当前股本近似）；筹码为本地模型推演值"
            out[code6] = {"chip": chip}
        except Exception as e:
            out[code6] = {"error": f"异常: {str(e)[:150]}"}

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
