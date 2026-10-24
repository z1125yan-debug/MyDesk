# Fix沪深 amount via TDX: Yahoo amount was close*volume estimate, TDX gives real amount
# Only update stock_daily_bar.amount where batch is from Yahoo (not TDX)
import sqlite3, urllib.request, json, concurrent.futures
DB="/home/hatch/workspace/kairotrend-p1/prisma/prisma/db/custom.db"
def tdx_rpc(method, params):
    payload=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    req=urllib.request.Request("http://127.0.0.1:8756/rpc", data=payload, headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        d=json.loads(r.read().decode())
        return d.get("result")
def to_tdx(sym):
    code, mkt=sym.split(".")
    return f"{mkt.lower()}{code}"
con=sqlite3.connect(DB)
cur=con.cursor()
cur.execute("SELECT DISTINCT symbol FROM stock_daily_bar WHERE symbol NOT LIKE '%.BJ' AND batch NOT LIKE 'tdx%'")
syms=[r[0] for r in cur.fetchall()]
print(f"HS/SZ to fix amount: {len(syms)}", flush=True)
con.close()
def fetch(sym):
    try:
        res=tdx_rpc("bars.get", {"code":to_tdx(sym),"period":"day","count":30})
        bars=res.get("bars",[])
        out={}
        for b in bars:
            out[b["time"][:10]]=float(b.get("amount",0))
        return (sym, out)
    except Exception as e:
        return (sym, {})
import concurrent.futures
updated=0
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
    futs={ex.submit(fetch, s): s for s in syms}
    con2=sqlite3.connect(DB)
    cur2=con2.cursor()
    done=0
    for fut in concurrent.futures.as_completed(futs):
        sym, amts=fut.result()
        for d, amt in amts.items():
            if d>="2026-09-28" and amt>0:
                cur2.execute("UPDATE stock_daily_bar SET amount=? WHERE symbol=? AND tradeDate=? AND adjust='qfq'", (amt, sym, d))
                if cur2.rowcount>0:
                    updated+=1
        done+=1
        if done%1000==0:
            con2.commit()
            print(f"amount fix {done}/{len(syms)} updated {updated}", flush=True)
    con2.commit()
    con2.close()
print(f"DONE amount fix updated {updated}", flush=True)
