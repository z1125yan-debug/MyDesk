#!/usr/bin/env python3
"""Backfill 2026-10-15 using Tencent qt.gtimg.cn (Yahoo's 10-15 close=None / open wrong)."""
import json, sqlite3, datetime, os, re, time, subprocess

def fetch_tencent(url):
    for attempt in range(3):
        try:
            out = subprocess.run(["curl","-s","--max-time","15","-H","User-Agent: Mozilla/5.0", url],
                                 capture_output=True, timeout=20)
            if out.returncode==0 and out.stdout:
                return out.stdout.decode("gbk", errors="ignore")
        except Exception as e:
            print(f" curl attempt {attempt} err {e}")
        time.sleep(0.5)
    return ""

ROOT="/home/hatch/workspace/kairotrend-p1"
DB=os.path.join(ROOT,"prisma/prisma/db/custom.db")
SECTOR=os.path.join(ROOT,"data/sector-constituents.json")

with open(SECTOR) as f:
    data=json.load(f)
universe={}
for ind, info in data.get("industries",{}).items():
    for m in info.get("members",[]):
        code=m.get("code")
        if code and len(code)==6 and code.isdigit():
            universe[code]=m.get("name","")
for code,name in [("000001","上证指数"),("399001","深证成指"),("600519","贵州茅台"),("002008","大族激光"),("000938","紫光股份"),("300821","东岳硅材")]:
    universe.setdefault(code,name)

def to_tencent(code):
    if code.startswith("6"):
        return f"sh{code}", f"{code}.SH"
    elif code.startswith(("0","3")):
        return f"sz{code}", f"{code}.SZ"
    else:
        return f"bj{code}", f"{code}.BJ"

# Batch fetch
codes=sorted(universe.keys())
print(f"Universe {len(codes)}")
results={}  # mysym -> {o,h,l,c,v,amt,prev}
BATCH=30
for i in range(0,len(codes),BATCH):
    batch=codes[i:i+BATCH]
    t_syms=[]
    for c in batch:
        t,_=to_tencent(c)
        t_syms.append(t)
    url="https://qt.gtimg.cn/q=" + ",".join(t_syms)
    txt=fetch_tencent(url)
    if not txt:
        print(f"batch {i} empty after retry")
        continue
    # Parse v_xxx="..."
    for m in re.finditer(r'v_(\w+?)="([^"]*)";', txt):
        t_sym=m.group(1)
        body=m.group(2)
        if body=="1" or "pv_none" in body:
            continue
        parts=body.split("~")
        # parts[3]=close, [4]=prev, [5]=open, [6]=volume(hands), [33]=high, [34]=low, [35]=price/vol/amt
        try:
            close=float(parts[3]); prev=float(parts[4]); open_p=float(parts[5]); vol_hands=float(parts[6]); high=float(parts[33]); low=float(parts[34])
            # amount from parts[35]: "63.37/501515/3203455697"
            amt=0.0
            if len(parts)>35 and "/" in parts[35]:
                amt=float(parts[35].split("/")[2])
            # map t_sym back to mysym: sh000001 -> 000001.SH, sz -> .SZ, bj -> .BJ
            code6=t_sym[2:]
            if t_sym.startswith("sh"):
                mysym=f"{code6}.SH"
            elif t_sym.startswith("sz"):
                mysym=f"{code6}.SZ"
            else:
                mysym=f"{code6}.BJ"
            vol=int(vol_hands*100)
            results[mysym]={"o":open_p,"h":high,"l":low,"c":close,"v":vol,"amt":amt,"prev":prev,"name":universe.get(code6,"")}
        except Exception as e:
            print(f"parse err {t_sym} {e} parts={parts[:10]}")
    if i % 300 == 0:
        print(f" fetched {i+len(batch)}/{len(codes)} ok {len(results)}", flush=True)
    time.sleep(0.2)

print(f"Fetched Tencent 10-15: {len(results)}/{len(codes)}")
# Write to DB
con=sqlite3.connect(DB)
cur=con.cursor()
inserted_close=0; inserted_bar=0
batch_str="tencent-2026-10-16"
now_iso=datetime.datetime.now().isoformat()
for mysym, info in results.items():
    # stock_daily_close
    cur.execute("INSERT OR IGNORE INTO stock_daily_close (id, symbol, tradeDate, close, name, createdAt) VALUES (?,?,?,?,?,?)",
                (f"{mysym}-2026-10-15-{os.urandom(4).hex()}", mysym, "2026-10-15", info["c"], info["name"], now_iso))
    if cur.rowcount>0:
        inserted_close+=1
    cur.execute("INSERT OR IGNORE INTO stock_daily_bar (symbol, tradeDate, adjust, open, high, low, close, volume, amount, batch, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (mysym, "2026-10-15", "qfq", info["o"], info["h"], info["l"], info["c"], info["v"], info["amt"], batch_str, now_iso))
    if cur.rowcount>0:
        inserted_bar+=1
con.commit()
print(f"Inserted 10-15 close {inserted_close} bar {inserted_bar}")

# Compute market_daily_stats for 2026-10-15 using closes from DB (need prev day 2026-10-14 closes)
# Load all closes for 10-14 and 10-15, plus MA history (need 5 days: 10-08..10-15 etc.)
# For MA, need closes for last 5 trading days up to 10-15: 10-08,10-09,10-12,10-13,10-14,10-15 (6 days, last 5 for MA5)
from collections import defaultdict
by_symbol=defaultdict(dict)
cur.execute("SELECT symbol, tradeDate, close FROM stock_daily_close WHERE tradeDate IN ('2026-10-08','2026-10-09','2026-10-12','2026-10-13','2026-10-14','2026-10-15')")
for sym, d, c in cur.fetchall():
    by_symbol[sym][d]=c

def threshold(sym):
    code=sym.split(".")[0]
    if code.startswith(("688","300")):
        return 0.199
    if code.startswith(("43","83","87","92")):
        return 0.299
    return 0.099

d="2026-10-15"; prev="2026-10-14"
decliners=0; limitUp=0; limitDown=0; belowMa5=0; belowMa3=0; aboveMa5_count=0; total=0
t3=t4=t5=0; maxBoards=0
# Need streak: need closes for earlier days too (for boards), load all closes from 09-28 onward for streak calc
cur.execute("SELECT symbol, tradeDate, close FROM stock_daily_close WHERE tradeDate >= '2026-09-28' ORDER BY tradeDate")
by_symbol_all=defaultdict(dict)
for sym, td, c in cur.fetchall():
    by_symbol_all[sym][td]=c

for mysym, closes in by_symbol_all.items():
    if d not in closes:
        continue
    total+=1
    c=closes[d]
    # MA
    dates_sorted=sorted([x for x in closes.keys() if x<=d])
    if len(dates_sorted)>=5:
        ma5=sum(closes[x] for x in dates_sorted[-5:])/5
        if c<ma5:
            belowMa5+=1
        else:
            aboveMa5_count+=1
    if len(dates_sorted)>=3:
        ma3=sum(closes[x] for x in dates_sorted[-3:])/3
        if c<ma3:
            belowMa3+=1
    if prev in closes:
        pc=closes[prev]
        if pc>0:
            chg=(c-pc)/pc
            if chg<0:
                decliners+=1
            th=threshold(mysym)
            if chg>=th:
                limitUp+=1
            if chg<=-th:
                limitDown+=1
    # streak
    streak=0
    for j in range(len(dates_sorted)-1,0,-1):
        cur_d=dates_sorted[j]; prev_d=dates_sorted[j-1]
        pc=closes[prev_d]; cc=closes[cur_d]
        if pc>0 and (cc-pc)/pc>=threshold(mysym):
            if cur_d==d or streak>0:
                streak+=1
            else:
                break
        else:
            break
    if streak>maxBoards:
        maxBoards=streak
    if streak==3:
        t3+=1
    elif streak==4:
        t4+=1
    elif streak>=5:
        t5+=1

aboveMa5Pct=(aboveMa5_count/total*100) if total else None
basis="腾讯 qt.gtimg.cn 实时收盘价 (2026-10-15) + 本地计算, 雅虎当日 close=None/开盘错故改用腾讯; 独立于用户电脑"
import uuid
cur.execute("SELECT id FROM market_daily_stats WHERE tradeDate=?", (d,))
row=cur.fetchone()
if row:
    cur.execute("UPDATE market_daily_stats SET limitUp=?, limitDown=?, t3=?, t4=?, t5=?, maxBoards=?, decliners=?, belowMa5=?, belowMa3=?, aboveMa5Pct=?, microPct=?, midPct=?, largePct=?, basis=?, updatedAt=? WHERE tradeDate=?",
                (limitUp, limitDown, t3, t4, t5, maxBoards, decliners, belowMa5, belowMa3, aboveMa5Pct, None, None, None, basis, now_iso, d))
else:
    cur.execute("INSERT INTO market_daily_stats (id, tradeDate, limitUp, limitDown, t3, t4, t5, maxBoards, decliners, belowMa5, belowMa3, aboveMa5Pct, microPct, midPct, largePct, basis, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (str(uuid.uuid4()), d, limitUp, limitDown, t3, t4, t5, maxBoards, decliners, belowMa5, belowMa3, aboveMa5Pct, None, None, None, basis, now_iso, now_iso))
# daily_snapshot
cur.execute("SELECT id FROM daily_snapshot WHERE tradeDate=?", (d,))
row2=cur.fetchone()
if row2:
    cur.execute("UPDATE daily_snapshot SET aboveMa5Pct=?, belowMa5=?, belowMa3=?, limitUp=?, limitDown=?, decliners=?, t3=?, t4=?, t5=?, maxBoards=?, breadthCount=?, basis=?, updatedAt=? WHERE tradeDate=?",
                (aboveMa5Pct, belowMa5, belowMa3, limitUp, limitDown, decliners, t3, t4, t5, maxBoards, total, basis, now_iso, d))
else:
    cur.execute("INSERT INTO daily_snapshot (id, tradeDate, aboveMa5Pct, belowMa5, belowMa3, limitUp, limitDown, decliners, t3, t4, t5, maxBoards, breadthCount, riskLevel, basis, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (str(uuid.uuid4()), d, aboveMa5Pct, belowMa5, belowMa3, limitUp, limitDown, decliners, t3, t4, t5, maxBoards, total, "", basis, now_iso, now_iso))
con.commit()
print(f"2026-10-15 stats: total={total} decliners={decliners} limitUp={limitUp} limitDown={limitDown} t3={t3} t4={t4} t5={t5} maxBoards={maxBoards} belowMa5={belowMa5} belowMa3={belowMa3} aboveMa5Pct={aboveMa5Pct}")
con.close()
print("DONE")
