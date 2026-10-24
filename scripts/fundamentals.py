#!/usr/bin/env python3
"""
基本面数据助手（腾讯实时行情 via 隧道代理）
- PE(TTM)、PB、换手率、市值：腾讯 qt.gtimg.cn（走隧道代理，稳定）
- 数据纪律：取不到返回 error，不编造

用法：python3 fundamentals.py 600893 002332
输出：JSON {code: {pe_ttm, pb, turnover_pct, mkt_cap_yi, error}}
"""
import sys
import json
import os
import subprocess


def get_tunnel_proxy():
    """从环境变量构造隧道代理地址"""
    https_proxy = os.environ.get("HTTPS_PROXY", "")
    if not https_proxy:
        return None
    # https_proxy=http://user:pass@hatch-egress-proxy:3128 → 换成 3130
    base = https_proxy.rsplit(":", 1)[0]
    return f"{base}:3130"


def tencent_code(code6):
    """6位代码 → 腾讯代码"""
    if code6.startswith("6") or code6.startswith("9"):
        return f"sh{code6}"
    elif code6.startswith("0") or code6.startswith("3"):
        return f"sz{code6}"
    elif code6.startswith("8") or code6.startswith("92"):
        return f"bj{code6}"
    return None


def fetch_tencent_quote(code6, proxy):
    """腾讯实时行情：解析 PE/PB/换手率/市值"""
    tc = tencent_code(code6)
    if not tc:
        return {"error": f"无法识别代码 {code6}"}

    url = f"https://qt.gtimg.cn/q={tc}"
    cmd = ["curl", "--proxy", proxy, "-s", "--max-time", "15", url]

    try:
        result = subprocess.run(cmd, capture_output=True, timeout=20)
        if result.returncode != 0:
            return {"error": f"curl 失败"}
        # 腾讯返回 GBK 编码
        try:
            data = result.stdout.decode("gbk", errors="ignore").strip()
        except:
            data = result.stdout.decode("utf-8", errors="ignore").strip()
        # 格式：v_sh600893="1~航发动力~600893~40.11~...~1.51~155.23~...~2.66~..."
        if "=" not in data:
            return {"error": "返回格式异常"}

        payload = data.split("=", 1)[1].strip().strip('";')
        fields = payload.split("~")

        # 腾讯字段位置（实测）：
        # [3]=现价, [38]=换手率%, [39]=PE, [46]=PB, [44]=总市值(亿), [45]=流通市值(亿)
        def safe_float(idx):
            try:
                v = fields[idx].strip()
                return float(v) if v and v != "" else None
            except (IndexError, ValueError):
                return None

        out = {"code": code6, "name": fields[1] if len(fields) > 1 else ""}
        price = safe_float(3)
        turnover = safe_float(38)
        pe = safe_float(39)
        pb = safe_float(46)
        mkt_cap = safe_float(44)

        if price:
            out["price"] = round(price, 2)
        if turnover is not None:
            out["turnover_pct"] = round(turnover, 2)
        if pe and pe > 0:
            out["pe_ttm"] = round(pe, 2)
        if pb and pb > 0:
            out["pb"] = round(pb, 2)
        if mkt_cap and mkt_cap > 0:
            out["mkt_cap_yi"] = round(mkt_cap, 2)

        # 至少要有价格才算成功
        if "price" not in out:
            return {"error": "未解析到价格数据"}

        out["source"] = "腾讯实时行情（隧道代理）"
        return out

    except subprocess.TimeoutExpired:
        return {"error": "请求超时"}
    except Exception as e:
        return {"error": f"异常: {str(e)[:100]}"}


def main():
    codes = sys.argv[1:]
    if not codes:
        print(json.dumps({"error": "请传入股票代码"}))
        sys.exit(1)

    proxy = get_tunnel_proxy()
    if not proxy:
        print(json.dumps({"error": "未找到隧道代理配置"}))
        sys.exit(1)

    out = {}
    for code in codes:
        code = code.strip()
        if not code.isdigit() or len(code) != 6:
            out[code] = {"error": "代码格式错误"}
            continue
        out[code] = fetch_tencent_quote(code, proxy)

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
