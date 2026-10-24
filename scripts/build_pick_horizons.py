#!/usr/bin/env python3
"""AI 优选四档持仓台账：每批每只记 T+1/T+3/T+5/T+20 净收益。
口径：买入 = 决策日次日（D+1）开盘；T+N = 买入日之后第 N 个交易日收盘卖（买入当天不计）；
净收益扣 0.41% 往返费（每档只扣一次）；胜 = 跑赢上证同期（买入日收盘→卖出日收盘，新浪日K口径）；
未到期/停牌缺 bar 留 null，不编。幂等：可重复跑，自动补齐已到期的档。
"""
import sqlite3, json, glob, os, urllib.request
from pathlib import Path
# 仓库版：BASE = 本仓库根目录（scripts/ 的上一级），不再写死本机绝对路径。
# 前置条件（本文件只算账，不产数据）：prisma/prisma/db/custom.db 已有 stock_daily_bar / market_daily_stats，
# data/ai-pick-versions/2026-*.json 已有 AI 优选版本文件（这两样是运行时数据，不进仓库）。
# 输出：默认写到仓库 data/pick-horizon-returns.jsonl；想写到旧位置时用环境变量覆盖：
#   PICK_HORIZON_OUT=~/workspace/goals/.../pick-horizon-returns.jsonl python3 scripts/build_pick_horizons.py
BASE = str(Path(__file__).resolve().parents[1])
OUT = os.path.expanduser(os.environ.get("PICK_HORIZON_OUT", str(Path(BASE) / "data" / "pick-horizon-returns.jsonl")))
HORIZONS = [1, 3, 5, 20]
FEE = 0.41

def index_closes():
    url = "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=sh000001&scale=240&ma=no&datalen=60"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn"})
    try:
        data = json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
    except Exception:
        op = urllib.request.build_opener(urllib.request.ProxyHandler({"http": os.environ.get("HTTP_PROXY", ""), "https": os.environ.get("HTTPS_PROXY", "")}))
        data = json.loads(op.open(req, timeout=15).read().decode())
    return {r["day"]: float(r["close"]) for r in data}

def compute_regimes(con):
    rows = con.execute("SELECT tradeDate, aboveMa5Pct FROM market_daily_stats ORDER BY tradeDate").fetchall()
    dates = [r[0] for r in rows]; pcts = {r[0]: r[1] for r in rows}
    MAP = {"主升": "强势", "震荡": "震荡", "退潮": "弱势", "修复": "弱势"}
    out = {}
    for date in dates:
        win = [d for d in dates if d <= date][-4:]
        if len(win) < 1 or pcts[date] is None: continue
        pct = pcts[date]; slope = pct - pcts[win[0]]
        if pct >= 60 and slope >= 0: b, ph = "主升", "强势上行"
        elif pct >= 40: b, ph = "震荡", ("高位分歧" if slope <= -15 else "震荡整理")
        elif slope < 0:
            b = "退潮"; ph = "退潮反抽" if len(win) >= 2 and pct > pcts[win[-2]] else "退潮下跌"
        else: b, ph = "修复", "低位修复"
        out[date] = {"bucket": b, "phase": ph, "regime3": MAP[b]}
    return out

con = sqlite3.connect(f"file:{BASE}/prisma/prisma/db/custom.db?mode=ro", uri=True)
con.execute("PRAGMA busy_timeout=8000")
idx = index_closes()
REGIMES = compute_regimes(con)
rows_out = []
# 同一决策日可能有多个版本文件（如 10-15 有 07:09 的 7 只版与 12:32 的 4 只版）：
# 以已结算台账为准取 picks 最多的那份（10-15 正式批 = 7 只版，结算均值 -1.26% 与之分毫不差）
by_day = {}
for fn in sorted(glob.glob(f"{BASE}/data/ai-pick-versions/2026-*.json")):
    d0 = json.load(open(fn))
    if d0["tradeDate"] not in by_day or len(d0["picks"]) > len(by_day[d0["tradeDate"]]["picks"]):
        by_day[d0["tradeDate"]] = d0
for day in sorted(by_day):
    d = by_day[day]
    if day < "2026-10-15":  # 台账自正式结算批次起
        continue
    for p in d["picks"]:
        sym, name = p["symbol"], p["name"]
        fut = con.execute("SELECT tradeDate, open, close FROM stock_daily_bar WHERE symbol=? AND adjust='qfq' AND tradeDate>? ORDER BY tradeDate ASC LIMIT 22", (sym, day)).fetchall()
        bars = con.execute("SELECT close, volume FROM stock_daily_bar WHERE symbol=? AND adjust='qfq' AND tradeDate<=? ORDER BY tradeDate DESC LIMIT 61", (sym, day)).fetchall()
        heat = None
        if len(bars) >= 21:
            cl = [b[0] for b in bars][::-1]
            chg = (bars[0][0] / bars[1][0] - 1) * 100
            ret20 = (bars[0][0] / bars[20][0] - 1) * 100
            g = l = 0.0
            for i in range(-14, 0):
                dd = cl[i] - cl[i - 1]
                if dd > 0: g += dd
                else: l -= dd
            rsi = 100.0 if l == 0 else 100 - 100 / (1 + (g / 14) / (l / 14))
            volr = bars[0][1] / (sum(b[1] for b in bars[1:21]) / 20)
            hot = sum([1 if rsi >= 60 else 0, 1 if chg >= 7 else 0, 1 if ret20 >= 20 else 0])
            heat = {"chg": round(chg, 1), "ret20": round(ret20, 1), "rsi": round(rsi), "volr": round(volr, 1),
                    "hot": hot, "judge": "过热" if hot >= 2 else ("留意" if hot == 1 else "正常")}
        rg = REGIMES.get(day)
        rec = {"batch": day, "regime3": rg["regime3"] if rg else None, "regime_raw": (rg["bucket"] + "·" + rg["phase"]) if rg else None, "symbol": sym, "name": name, "heat": heat, "buy_date": None, "buy_price": None, "horizons": {}}
        if fut and fut[0][1]:
            rec["buy_date"], rec["buy_price"] = fut[0][0], fut[0][1]
            buy_idx = idx.get(fut[0][0])
            for h in HORIZONS:
                key = f"t{h}"
                if len(fut) > h:
                    sell_date, sell_close = fut[h][0], fut[h][2]
                    net = round((sell_close / fut[0][1] - 1) * 100 - FEE, 2)
                    sell_idx = idx.get(sell_date)
                    idx_ret = round((sell_idx / buy_idx - 1) * 100, 2) if buy_idx and sell_idx else None
                    rec["horizons"][key] = {"sell_date": sell_date, "sell_price": sell_close, "net": net,
                                            "index_ret": idx_ret, "win": (net > idx_ret) if idx_ret is not None else None}
                else:
                    rec["horizons"][key] = None
        rows_out.append(rec)
with open(OUT, "w") as f:
    for r in rows_out:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
# 汇总
from collections import defaultdict
agg = defaultdict(lambda: defaultdict(list))
for r in rows_out:
    for h in HORIZONS:
        v = r["horizons"].get(f"t{h}")
        if v: agg[r["batch"]][h].append(v)
for day in sorted(agg):
    line = [day]
    for h in HORIZONS:
        vs = agg[day][h]
        if vs:
            avg = sum(v["net"] for v in vs) / len(vs)
            wins = sum(1 for v in vs if v["win"])
            line.append(f"T+{h}: {avg:+.2f}% ({wins}胜{len(vs)-wins}负, n={len(vs)})")
        else:
            line.append(f"T+{h}: —")
    print(" | ".join(line))
for rg3 in ["强势", "震荡", "弱势"]:
    sub = [r for r in rows_out if r.get("regime3") == rg3]
    if not sub: print(rg3, "| 暂无批次"); continue
    cells = []
    for h in HORIZONS:
        vs = [r["horizons"][f"t{h}"] for r in sub if r["horizons"].get(f"t{h}")]
        if vs:
            avg = sum(v["net"] for v in vs) / len(vs); wins = sum(1 for v in vs if v["win"])
            cells.append(f"T+{h}: {avg:+.2f}% ({wins}胜{len(vs)-wins}负, {len(vs)}只)")
        else: cells.append(f"T+{h}: —")
    print(rg3, f"({len(set(r['batch'] for r in sub))}批{len(sub)}只) |", " | ".join(cells))
print("ledger:", OUT, len(rows_out), "rows")
