# scripts/quant/backfill-sector-history.py
# Phase 0② 板块历史宽度/RS 库回补：读 stock_daily_close（2026-04-20~09-24，607k 行），
# 按申万行业（sector-constituents.json 的当前成分+静态档）聚合每日：
#   breadth（涨/跌/平家数、上涨占比）、均值/中位涨跌幅、结构性分解（龙头/核心/二线组涨跌）、
#   龙头组下带比例、RS 代理（行业中位 - 全A中位）、前期涨幅 5/20/60/120 交易日。
# 写回 data/sector-daily-snapshots.json（与实时快照同 schema，按交易日 upsert，不覆盖 09-28 实时条）。
#
# 口径注意（与项目 universeMembership=current_only 同源）：用「当前成分」回放历史 = 幸存者/快照偏差，
# 历史成分与 04-20 实际不同（IPO/退市/申万重分类）。属已知近似，落 meta.caveat 明示，不冒充无偏。
import sqlite3, json, os

ROOT = r"D:/Zai/kairotrend-p1"
CONS = os.path.join(ROOT, "data", "sector-constituents.json")
DB = os.path.join(ROOT, "prisma", "db", "custom.db")
ARCHIVE = os.path.join(ROOT, "data", "sector-daily-snapshots.json")

K_WINDOWS = (5, 20, 60, 120)


def to_sym(code):
    c = str(code)
    if c.startswith("6"):
        return c + ".SH"
    if c.startswith(("0", "3")):
        return c + ".SZ"
    if c.startswith(("8", "4")):
        return c + ".BJ"
    return None


def med(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    xs.sort()
    n = len(xs)
    m = n // 2
    return xs[m] if n % 2 else (xs[m - 1] + xs[m]) / 2.0


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def r2(x):
    return None if x is None else round(x * 100) / 100.0


cons = json.load(open(CONS, encoding="utf8"))
ind_src = cons.get("industries", {})
ind_members = {}
for ind, obj in ind_src.items():
    lst = [(to_sym(m["code"]), m.get("tier")) for m in obj.get("members", []) if to_sym(m.get("code"))]
    if lst:
        ind_members[ind] = lst
print(f"申万行业 {len(ind_members)} 个，读 stock_daily_close …")

con = sqlite3.connect(DB)
cur = con.cursor()
cur.execute("SELECT symbol, tradeDate, close FROM stock_daily_close")
rows = cur.fetchall()
con.close()

# series[sym] = [(date, close)] 升序；pos[sym] = {date: 局部下标}
series = {}
for sym, date, close in rows:
    series.setdefault(sym, []).append((date, close))
for s in series:
    series[s].sort()
pos = {s: {d: i for i, (d, _) in enumerate(sl)} for s, sl in series.items()}
dates = sorted({d for _, d, _ in rows})
print(f"交易日 {len(dates)} 个（{dates[0]}~{dates[-1]}），个股 {len(series)} 只")

archive = {"meta": None, "days": {}}
if os.path.exists(ARCHIVE):
    try:
        archive = json.load(open(ARCHIVE, encoding="utf8"))
    except Exception as e:
        print("归档解析失败，重建:", e)

written = 0
for di, d in enumerate(dates):
    # 全A 当日中位涨跌（RS 基准）：所有当日有「前一日收盘价」的票
    allA = []
    for sym, sl in series.items():
        j = pos[sym].get(d)
        if j is None or j == 0:
            continue
        pc = sl[j - 1][1]
        if pc:
            allA.append((sl[j][1] - pc) / pc * 100.0)
    allA_med = med(allA)

    industries = []
    for ind, members in ind_members.items():
        ch = []
        by_tier = {"leader": [], "core": [], "second": []}
        adv = dec = unch = cov = 0
        pre = {k: [] for k in K_WINDOWS}
        for sym, tier in members:
            sl = series.get(sym)
            if not sl:
                continue
            j = pos[sym].get(d)
            if j is None:
                continue
            cov += 1
            c = sl[j][1]
            if j > 0:
                pc = sl[j - 1][1]
                if pc:
                    pct = (c - pc) / pc * 100.0
                    ch.append(pct)
                    if pct > 0:
                        adv += 1
                    elif pct < 0:
                        dec += 1
                    else:
                        unch += 1
                    if tier in by_tier:
                        by_tier[tier].append(pct)
            for k in K_WINDOWS:
                if j - k >= 0:
                    bc = sl[j - k][1]
                    if bc:
                        pre[k].append((c - bc) / bc * 100.0)
        if not cov:
            continue
        m = med(ch)
        leader_dec = sum(1 for x in by_tier["leader"] if x < 0)
        industries.append({
            "name": ind,
            "count": cov,
            "adv": adv,
            "dec": dec,
            "unch": unch,
            "advPct": r2((adv / cov) * 100) if ch else None,
            "meanChange": r2(mean(ch)),
            "medianChange": r2(m),
            "leaderChange": r2(mean(by_tier["leader"])),
            "coreChange": r2(mean(by_tier["core"])),
            "secondChange": r2(mean(by_tier["second"])),
            "leadersDecliningPct": r2((leader_dec / len(by_tier["leader"])) * 100) if by_tier["leader"] else None,
            "rsProxy": r2(m - allA_med) if (m is not None and allA_med is not None) else None,
            "prevChange5": r2(med(pre[5])),
            "prevChange20": r2(med(pre[20])),
            "prevChange60": r2(med(pre[60])),
            "prevChange120": r2(med(pre[120])),
            "top": [],
        })
    industries.sort(key=lambda x: (x["medianChange"] if x["medianChange"] is not None else 0))

    day = {
        "tradeDate": d,
        "computedAt": "backfill:stock_daily_close",
        "kind": "sw-industry",
        "source": "stock_daily_close(不复权收盘价 vs 前一日)",
        "session": "close",
        "allA": {"count": len(allA), "medianChange": r2(allA_med)},
        "industries": industries,
    }
    # Δ vs 上一交易日（dates[di-1]）
    if di > 0:
        pd = dates[di - 1]
        pday = archive["days"].get(pd)
        if pday:
            pmap = {x["name"]: x for x in pday.get("industries", [])}
            for ind in day["industries"]:
                p = pmap.get(ind["name"])
                if not p:
                    continue
                ind["delta"] = {
                    "prevDate": pd,
                    "medianChange": r2(ind["medianChange"] - (p["medianChange"] or 0)),
                    "advPct": r2((ind["advPct"] or 0) - (p["advPct"] or 0)),
                    "rsProxy": r2((ind["rsProxy"] or 0) - (p["rsProxy"] or 0)) if ind["rsProxy"] is not None and p["rsProxy"] is not None else None,
                }
            day["deltaBase"] = {"prevDate": pd}
    archive["days"][d] = day
    written += 1

archive["meta"] = {
    "universe": "申万一级行业(industry-map.json，当前成分)",
    "note": "每日 upsert；实时快照(腾讯)与历史回填(stock_daily_close)同 schema；Δ 由上一交易日推算",
    "source": "qt.gtimg.cn(实时) / stock_daily_close(历史)",
    "caveat": "历史库用当前成分回放=幸存者/快照偏差（universeMembership=current_only），非 04-20 实际成分",
}
json.dump(archive, open(ARCHIVE, "w", encoding="utf8"), ensure_ascii=False, indent=2)
print(f"回补完成：写入 {written} 个交易日（{dates[0]}~{dates[-1]}）；归档总天数 {len(archive['days'])}")
print("落档:", ARCHIVE)
