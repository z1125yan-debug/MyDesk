#!/usr/bin/env python3
"""Backfill missing 933 RPS-only stocks (SH/SZ, incl ST) for 2026-09-28..2026-10-15.
Yahoo for 09-28..10-14, Tencent for 10-15. ST uses 5% threshold in stats recompute (done in second script).
Dates: Shanghai timezone ts+8h, aligned with A-share trading days."""
import json, sqlite3, urllib.request, time, datetime, os, re, subprocess, concurrent.futures
ROOT="/home/hatch/workspace/kairotrend-p1"
DB=os.path.join(ROOT,"prisma/prisma/db/custom.db")
SECTOR=os.path.join(ROOT,"data/sector-constituents.json")
RPS=os.path.join(ROOT,"data/rps-seed-latest.json")

sec=json.load(open(SECTOR))
sec_codes=set()
for ind in sec['industries'].values():
    for m in ind['members']:
        sec_codes.add(m['code'])
rps=json.load(open(RPS))
missing=[]
for r in rps['rows']:
    code=r['symbol']
    if code not in sec_codes:
        missing.append((code, r['name']))
print(f"Missing RPS-only: {len(missing)}")
# Also need to check: sector-only 62 are already in DB, skip
# Fetch Yahoo for missing
START="2026-09-01"; END="2026-10-17"; TARGET="2026-09-28"
period1=int(time.mktime(time.strptime(START, "%Y-%m-%d")))
period2=int(time.mktime(time.strptime(END, "%Y-%m-%d")))

def to_yahoo(code):
    if code.startswith("6"):
        return f"{code}.SS", f"{code}.SH"
    else:
        return f"{code}.SZ", f"{code}.SZ"

def fetch_yahoo(ysym):
    url=f"https://query1.finance.yahoo.com/v8/finance/chart/{ysym}?period1={period1}&period2={period2}&interval=1d&includePrePost=false"
    req=urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        d=json.loads(r.read().decode())
        res=d["chart"]["result"][0]
        ts=res.get("timestamp") or []
        q=res["indicators"]["quote"][0]
        out=[]
        for i,t in enumerate(ts):
            dt=datetime.datetime.fromtimestamp(t, datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d")
            o=q["open"][i]; h=q["high"][i]; l=q["low"][i]; c=q["close"][i]; v=q["volume"][i]
            if c is None or o is None or h is None or l is None:
                continue
            if h < max(o,c)-0.01 or l > min(o,c)+0.01:
                continue
            vol=int(v) if v is not None else 0
            amt=float(c*vol) if vol else 0.0
            out.append({"date":dt,"o":float(o),"h":float(h),"l":float(l),"c":float(c),"v":vol,"amt":amt})
        return out

def fetch_one(item):
    code,name=item
    ysym,mysym=to_yahoo(code)
    try:
        bars=fetch_yahoo(ysym)
        return (mysym,name,bars)
    except Exception as e:
        return (mysym,name,[])

all_bars={}
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
    futs={ex.submit(fetch_one, it): it for it in missing}
    done=0
    for fut in concurrent.futures.as_completed(futs):
        mysym,name,bars=fut.result()
        if bars:
            all_bars[mysym]={"name":name,"bars":bars}
        done+=1
        if done%200==0:
            print(f" yahoo {done}/{len(missing)} ok {len(all_bars)}", flush=True)
print(f"Yahoo fetched ok {len(all_bars)}/{len(missing)}")

# Fetch Tencent for 2026-10-15 for missing (Yahoo's 10-15 is broken)
def fetch_tencent(url):
    for attempt in range(3):
        try:
            out=subprocess.run(["curl","-s","--max-time","15","-H","User-Agent: Mozilla/5.0", url], capture_output=True, timeout=20)
            if out.returncode==0 and out.stdout:
                return out.stdout.decode("gbk", errors="ignore")
        except Exception:
            pass
        time.sleep(0.5)
    return ""

def to_tencent(code):
    if code.startswith("6"):
        return f"sh{code}"
    else:
        return f"sz{code}"

tencent_1015={}
codes=[c for c,_ in missing]
for i in range(0,len(codes),30):
    batch=codes[i:i+30]
    url="https://qt.gtimg.cn/q=" + ",".join([to_tencent(c) for c in batch])
    txt=fetch_tencent(url)
    if not txt:
        continue
    for m in re.finditer(r'v_(\w+?)="([^"]*)";', txt):
        t_sym=m.group(1); body=m.group(2)
        if body=="1" or "pv_none" in body:
            continue
        parts=body.split("~")
        try:
            close=float(parts[3]); open_p=float(parts[5]); vol_hands=float(parts[6]); high=float(parts[33]); low=float(parts[34])
            amt=0.0
            if len(parts)>35 and "/" in parts[35]:
                amt=float(parts[35].split("/")[2])
            code6=t_sym[2:]
            mysym=f"{code6}.SH" if t_sym.startswith("sh") else f"{code6}.SZ"
            # name from missing dict
            name=dict(missing).get(code6,"")
            tencent_1015[mysym]={"o":open_p,"h":high,"l":low,"c":close,"v":int(vol_hands*100),"amt":amt,"name":name}
        except Exception as e:
            print(f"parse {t_sym} {e}")
    if i%300==0:
        print(f" tencent {i+len(batch)}/{len(codes)} ok {len(tencent_1015)}", flush=True)
print(f"Tencent 10-15 fetched {len(tencent_1015)}/{len(codes)}")

# Write to DB
con=sqlite3.connect(DB)
cur=con.cursor()
def fix_dt(s):
    # s like "2026-10-16T00:xx:xx.xxxxxx" -> "2026-10-16T00:xx:xx.xxxZ"
    try:
        dt=datetime.datetime.fromisoformat(s.replace(" ", "T").replace("Z",""))
        ms=dt.microsecond//1000
        return dt.strftime("%Y-%m-%dT%H:%M:%S")+f".{ms:03d}Z"
    except:
        return datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S.000Z")
now_iso=fix_dt(datetime.datetime.now().isoformat())
batch_str="yahoo-tencent-missing933-2026-10-16"
inserted_close=0; inserted_bar=0
for mysym, info in all_bars.items():
    for b in info["bars"]:
        if b["date"] < TARGET or b["date"]=="2026-10-15":
            # Skip 10-15 from Yahoo (broken), will use Tencent
            if b["date"]=="2026-10-15":
                continue
            if b["date"] < TARGET:
                continue
        cur.execute("INSERT OR IGNORE INTO stock_daily_close (id, symbol, tradeDate, close, name, createdAt) VALUES (?,?,?,?,?,?)",
                    (f"{mysym}-{b['date']}-{os.urandom(4).hex()}", mysym, b["date"], b["c"], info["name"], now_iso))
        if cur.rowcount>0:
            inserted_close+=1
        cur.execute("INSERT OR IGNORE INTO stock_daily_bar (symbol, tradeDate, adjust, open, high, low, close, volume, amount, batch, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (mysym, b["date"], "qfq", b["o"], b["h"], b["l"], b["c"], b["v"], b["amt"], batch_str, now_iso))
        if cur.rowcount>0:
            inserted_bar+=1
print(f"Yahoo inserted close {inserted_close} bar {inserted_bar}")
# Tencent 10-15
for mysym, info in tencent_1015.items():
    cur.execute("INSERT OR IGNORE INTO stock_daily_close (id, symbol, tradeDate, close, name, createdAt) VALUES (?,?,?,?,?,?)",
                (f"{mysym}-2026-10-15-{os.urandom(4).hex()}", mysym, "2026-10-15", info["c"], info["name"], now_iso))
    if cur.rowcount>0:
        inserted_close+=1
    cur.execute("INSERT OR IGNORE INTO stock_daily_bar (symbol, tradeDate, adjust, open, high, low, close, volume, amount, batch, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (mysym, "2026-10-15", "qfq", info["o"], info["h"], info["l"], info["c"], info["v"], info["amt"], "tencent-2026-10-16", now_iso))
    if cur.rowcount>0:
        inserted_bar+=1
con.commit()
print(f"Total inserted close {inserted_close} bar {inserted_bar}")
con.close()
print("DONE Yahoo+Tencent for missing 933")
