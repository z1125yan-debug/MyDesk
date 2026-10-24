#!/usr/bin/env python3
"""Yahoo Finance backfill for MyDesk, independent of user's PC / TDX gateway.
Fills stock_daily_close + stock_daily_bar for missing trading days 2026-09-25..2026-10-16
using Yahoo Finance chart API (accessible from this VM via egress proxy).
Universe from data/sector-constituents.json (4281 stocks).
Also computes market_daily_stats for missing days from those closes.
Basis is recorded in basis field: Yahoo qfq approx, not TDX/Eastmoney.
"""
import json, sqlite3, urllib.request, time, datetime, os, sys, concurrent.futures

ROOT = "/home/hatch/workspace/kairotrend-p1"
DB = os.path.join(ROOT, "prisma/prisma/db/custom.db")
SECTOR_FILE = os.path.join(ROOT, "data/sector-constituents.json")

# Fetch window: need history for MA5/MA3, so start 2026-09-01
START = "2026-09-01"
END = "2026-10-17"  # exclusive
TARGET_START = "2026-09-25"  # only insert >= this (seed ends 2026-09-24)

def to_yahoo_symbol(code6, market_hint=""):
    # code6 like "600406", need market: 6xx -> SS, 0xx/3xx -> SZ, 4xx/8xx/9xx -> BJ (Yahoo uses .BJ? Actually Yahoo uses .SS/.SZ, BJ may not be covered, try .SS for 4xx? We'll try .BJ first, fallback)
    if code6.startswith("6"):
        return f"{code6}.SS", f"{code6}.SH"
    elif code6.startswith(("0","3")):
        return f"{code6}.SZ", f"{code6}.SZ"
    else:
        # BJ: 43xxxx, 83xxxx, 87xxxx, 92xxxx
        return f"{code6}.BJ", f"{code6}.BJ"

def fetch_yahoo(yahoo_sym, period1, period2):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_sym}?period1={period1}&period2={period2}&interval=1d&includePrePost=false"
    req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.loads(r.read().decode())
        res = d["chart"]["result"][0]
        ts = res.get("timestamp") or []
        q = res["indicators"]["quote"][0]
        out = []
        for i, t in enumerate(ts):
            dt = datetime.datetime.fromtimestamp(t, datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d")
            o = q["open"][i]; h = q["high"][i]; l = q["low"][i]; c = q["close"][i]; v = q["volume"][i]
            if c is None or o is None or h is None or l is None:
                continue
            # Yahoo sometimes returns bad bars where H < O or L > C for incomplete days; skip those
            if h < max(o,c) - 0.01 or l > min(o,c) + 0.01:
                continue
            vol = int(v) if v is not None else 0
            amt = float(c * vol) if vol else 0.0  # approx: close*volume, Yahoo has no amount
            out.append({"date": dt, "o": float(o), "h": float(h), "l": float(l), "c": float(c), "v": vol, "amt": amt})
        return out

def main():
    print(f"Loading universe from {SECTOR_FILE}", flush=True)
    with open(SECTOR_FILE) as f:
        data = json.load(f)
    universe = {}  # code6 -> name
    for ind, info in data.get("industries", {}).items():
        for m in info.get("members", []):
            code = m.get("code")
            if code and len(code)==6 and code.isdigit():
                universe[code] = m.get("name","")
    print(f"Universe: {len(universe)} stocks", flush=True)
    # Also add indices and the 3 stocks from article if missing
    for code, name in [("000001","上证指数"),("399001","深证成指"),("600519","贵州茅台"),("002008","大族激光"),("000938","紫光股份"),("300821","东岳硅材")]:
        if code not in universe:
            universe[code]=name

    period1 = int(time.mktime(time.strptime(START, "%Y-%m-%d")))
    period2 = int(time.mktime(time.strptime(END, "%Y-%m-%d")))

    # Fetch all
    all_bars = {}  # mysym -> list of bars
    codes = sorted(universe.keys())
    def fetch_one(code):
        name = universe[code]
        ysym, mysym = to_yahoo_symbol(code)
        try:
            bars = fetch_yahoo(ysym, period1, period2)
            # Filter to >= START, and also try fallback for BJ: if no bars and BJ, try .SS?
            if not bars and ysym.endswith(".BJ"):
                try:
                    bars = fetch_yahoo(f"{code}.SS", period1, period2)
                    mysym = f"{code}.SH" if code.startswith("6") else f"{code}.SZ"
                except Exception:
                    pass
            return (mysym, name, bars)
        except Exception as e:
            return (mysym, name, [])

    print("Fetching Yahoo (4281 symbols, 10 workers, may take ~10-20 min)...", flush=True)
    done=0
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        futs = {ex.submit(fetch_one, c): c for c in codes}
        for fut in concurrent.futures.as_completed(futs):
            mysym, name, bars = fut.result()
            if bars:
                all_bars[mysym] = {"name": name, "bars": bars}
            done+=1
            if done % 500 == 0:
                print(f"  fetched {done}/{len(codes)}, ok {len(all_bars)}", flush=True)
    print(f"Fetched ok: {len(all_bars)}/{len(codes)}", flush=True)

    # Write to DB
    con = sqlite3.connect(DB)
    cur = con.cursor()
    # Ensure tables exist (they do)
    # Insert stock_daily_close + stock_daily_bar for >= TARGET_START
    inserted_close=0; inserted_bar=0
    for mysym, info in all_bars.items():
        name = info["name"]
        for b in info["bars"]:
            if b["date"] < TARGET_START:
                continue
            # stock_daily_close
            try:
                cur.execute("INSERT OR IGNORE INTO stock_daily_close (id, symbol, tradeDate, close, name, createdAt) VALUES (?,?,?, ?, ?, ?)",
                            (f"{mysym}-{b['date']}-{int(time.time()*1000)}-{os.urandom(4).hex()}", mysym, b["date"], b["c"], name, datetime.datetime.now().isoformat()))
                if cur.rowcount>0:
                    inserted_close+=1
            except Exception as e:
                print(f"close insert err {mysym} {b['date']} {e}", flush=True)
            # stock_daily_bar
            batch = "yahoo-2026-10-16"
            now_iso = datetime.datetime.now().isoformat()
            try:
                cur.execute("INSERT OR IGNORE INTO stock_daily_bar (symbol, tradeDate, adjust, open, high, low, close, volume, amount, batch, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                            (mysym, b["date"], "qfq", b["o"], b["h"], b["l"], b["c"], b["v"], b["amt"], batch, now_iso))
                if cur.rowcount>0:
                    inserted_bar+=1
            except Exception as e:
                print(f"bar insert err {mysym} {b['date']} {e}", flush=True)
        if inserted_close % 5000 == 0 and inserted_close>0:
            con.commit()
    con.commit()
    print(f"Inserted stock_daily_close: {inserted_close}, stock_daily_bar: {inserted_bar}", flush=True)

    # Compute market_daily_stats for missing days
    # Need per-symbol closes sorted by date
    from collections import defaultdict
    by_date = defaultdict(list)  # date -> list of (symbol, close)
    by_symbol = defaultdict(dict)  # symbol -> {date: close}
    for mysym, info in all_bars.items():
        for b in info["bars"]:
            by_date[b["date"]].append((mysym, b["c"]))
            by_symbol[mysym][b["date"]] = b["c"]
    # Trading days = dates >= TARGET_START that have data, sorted
    trading_days = sorted([d for d in by_date.keys() if d >= TARGET_START])
    print(f"Trading days to compute stats: {trading_days}", flush=True)
    for d in trading_days:
        # Need prev trading day for change calc: find prev date in all bars (including before TARGET_START)
        all_dates = sorted(set([b["date"] for info in all_bars.values() for b in info["bars"]]))
        idx = all_dates.index(d) if d in all_dates else -1
        prev = all_dates[idx-1] if idx>0 else None
        # decliners, limitUp/Down
        decliners=0; limitUp=0; limitDown=0
        # For MA: need 5 closes including today, and 3 closes
        belowMa5=0; belowMa3=0; total=0; aboveMa5_count=0
        # For boards: need consecutive limit-ups: for each symbol, count consecutive days up to today where change >= threshold
        # Threshold by symbol: 688/300 -> 20%, BJ (43/83/87/92) -> 30%, else 10%
        def threshold(sym):
            code = sym.split(".")[0]
            if code.startswith(("688","300")):
                return 0.199
            if code.startswith(("43","83","87","92")):
                return 0.299
            return 0.099
        t3=t4=t5=0; maxBoards=0
        for mysym, closes in by_symbol.items():
            if d not in closes:
                continue
            total+=1
            c = closes[d]
            # MA5/MA3: need 5 / 3 closes ending today
            # Get last 5 dates <= d for this symbol
            dates_sorted = sorted([x for x in closes.keys() if x <= d])
            if len(dates_sorted)>=5:
                ma5 = sum(closes[x] for x in dates_sorted[-5:])/5
                if c < ma5:
                    belowMa5+=1
                else:
                    aboveMa5_count+=1
            if len(dates_sorted)>=3:
                ma3 = sum(closes[x] for x in dates_sorted[-3:])/3
                if c < ma3:
                    belowMa3+=1
            if prev and prev in closes:
                pc = closes[prev]
                if pc>0:
                    chg = (c-pc)/pc
                    if chg < 0:
                        decliners+=1
                    th = threshold(mysym)
                    if chg >= th:
                        limitUp+=1
                    if chg <= -th:
                        limitDown+=1
            # Boards: count consecutive limit-ups ending today
            boards=0
            # walk backwards
            for j in range(len(dates_sorted)-1, -1, -1):
                cur_d = dates_sorted[j]
                if j==0:
                    break
                prev_d = dates_sorted[j-1]
                # Need consecutive trading days? If gap > 5 days, break (holiday)
                # Simplify: check change vs prev available close
                pc = closes[prev_d]
                cc = closes[cur_d]
                if pc>0 and (cc-pc)/pc >= threshold(mysym):
                    boards+=1
                else:
                    break
                # Only count if cur_d == d for current streak, else break after first non-d? Actually we walk from today backwards, so first iteration is today vs prev, if not limit-up, boards=0
                if cur_d != d and boards>0:
                    # We already counted today, continue for streak
                    pass
                if cur_d == d and boards==0:
                    break
            # The above loop counts streak including today if today is limit-up, else 0
            # But our loop started from today and went back, so boards is streak length
            if boards>=3:
                t3+=1 if boards==3 else 0
                # Actually t3 = exactly 3 boards, t4 = exactly 4, t5 = >=5
                pass
            if boards==3:
                t3+=0  # already counted? Let's recompute correctly below
            # Recompute cleanly: use separate logic
            # (We'll recompute t3/t4/t5 separately after loop to avoid confusion)
        # Recompute boards cleanly
        t3=t4=t5=0; maxBoards=0
        for mysym, closes in by_symbol.items():
            if d not in closes:
                continue
            dates_sorted = sorted([x for x in closes.keys() if x <= d])
            streak=0
            for j in range(len(dates_sorted)-1, 0, -1):
                cur_d = dates_sorted[j]
                prev_d = dates_sorted[j-1]
                pc = closes[prev_d]; cc = closes[cur_d]
                if pc>0 and (cc-pc)/pc >= threshold(mysym):
                    # Only count if cur_d is part of streak ending at d: need j to be contiguous from end
                    if cur_d == d or streak>0:
                        streak+=1
                    else:
                        break
                else:
                    break
                if cur_d != d and streak==0:
                    break
            # streak is number of consecutive limit-up days ending at d (if today not limit-up, streak=0 because first check fails)
            # Actually if today not limit-up, first iteration (cur_d=d) fails, streak stays 0, correct.
            if streak>maxBoards:
                maxBoards=streak
            if streak==3:
                t3+=1
            elif streak==4:
                t4+=1
            elif streak>=5:
                t5+=1
        aboveMa5Pct = (aboveMa5_count/total*100) if total else None
        # micro/mid/large: we don't have market cap, set None
        basis = "Yahoo Finance 日K(qfq近似, amount=close*volume估算) + 本地计算, 非通达信/东财口径; 独立于用户电脑"
        # Insert or replace market_daily_stats
        try:
            cur.execute("SELECT id FROM market_daily_stats WHERE tradeDate=?", (d,))
            row = cur.fetchone()
            if row:
                cur.execute("UPDATE market_daily_stats SET limitUp=?, limitDown=?, t3=?, t4=?, t5=?, maxBoards=?, decliners=?, belowMa5=?, belowMa3=?, aboveMa5Pct=?, microPct=?, midPct=?, largePct=?, basis=?, updatedAt=? WHERE tradeDate=?",
                            (limitUp, limitDown, t3, t4, t5, maxBoards, decliners, belowMa5, belowMa3, aboveMa5Pct, None, None, None, basis, datetime.datetime.now().isoformat(), d))
            else:
                import uuid
                cur.execute("INSERT INTO market_daily_stats (id, tradeDate, limitUp, limitDown, t3, t4, t5, maxBoards, decliners, belowMa5, belowMa3, aboveMa5Pct, microPct, midPct, largePct, basis, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (str(uuid.uuid4()), d, limitUp, limitDown, t3, t4, t5, maxBoards, decliners, belowMa5, belowMa3, aboveMa5Pct, None, None, None, basis, datetime.datetime.now().isoformat(), datetime.datetime.now().isoformat()))
            print(f"{d}: total={total} decliners={decliners} limitUp={limitUp} limitDown={limitDown} t3={t3} t4={t4} t5={t5} maxBoards={maxBoards} belowMa5={belowMa5} belowMa3={belowMa3} aboveMa5Pct={aboveMa5Pct}", flush=True)
            # Also daily_snapshot
            try:
                cur.execute("SELECT id FROM daily_snapshot WHERE tradeDate=?", (d,))
                row2 = cur.fetchone()
                if row2:
                    cur.execute("UPDATE daily_snapshot SET aboveMa5Pct=?, belowMa5=?, belowMa3=?, limitUp=?, limitDown=?, decliners=?, t3=?, t4=?, t5=?, maxBoards=?, breadthCount=?, basis=?, updatedAt=? WHERE tradeDate=?",
                                (aboveMa5Pct, belowMa5, belowMa3, limitUp, limitDown, decliners, t3, t4, t5, maxBoards, total, basis, datetime.datetime.now().isoformat(), d))
                else:
                    import uuid
                    cur.execute("INSERT INTO daily_snapshot (id, tradeDate, aboveMa5Pct, belowMa5, belowMa3, limitUp, limitDown, decliners, t3, t4, t5, maxBoards, breadthCount, riskLevel, basis, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                (str(uuid.uuid4()), d, aboveMa5Pct, belowMa5, belowMa3, limitUp, limitDown, decliners, t3, t4, t5, maxBoards, total, "", basis, datetime.datetime.now().isoformat(), datetime.datetime.now().isoformat()))
            except Exception as e:
                print(f"daily_snapshot err {d} {e}", flush=True)
        except Exception as e:
            print(f"market_daily_stats err {d} {e}", flush=True)
    con.commit()
    con.close()
    print("DONE", flush=True)

if __name__ == "__main__":
    main()
