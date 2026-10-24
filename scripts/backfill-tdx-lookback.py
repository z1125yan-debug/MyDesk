#!/usr/bin/env python3
"""Backfill lookback history for layer1 (ONE-FIX for backtest leak #1).

Backtest proof (2026-09-16..10-14, 15 decision days):
  - 11 of 13 Top5 strategies had ZERO hits all month (need MA60/MA144/RSV81/MACD
    = 20-144 bars, DB only had <=15 bars per symbol).
  - The flow was effectively 620-only (底分型): 90 picks, T+1 avg -1.41%, win 37.8%.
  - 1221 (the only other firing strategy) was +1.14% T+1, win 63.6% even with
    warmup-degraded signals.
Fix: give layer1 the history its indicators need. Fetch 200 bars/symbol via TDX
(~10 months, covers MA144 + RSV81 + MACD warmup with margin; for decision day
09-16 that leaves 181 bars of lookback). INSERT OR IGNORE; only dates < 09-16
are new (09-16..10-16 already present). Failures recorded, never fabricated.
Checkpoint: data/backfill-checkpoint-lookback.json (separate file).
"""
import json
import os
import sqlite3
import sys
import time
import datetime
import concurrent.futures
from pathlib import Path
import importlib.util as _ilu

BASE = Path(__file__).resolve().parent.parent
_spec = _ilu.spec_from_file_location("backfill_tdx", str(BASE / "scripts" / "backfill-tdx.py"))
assert _spec and _spec.loader
bt = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(bt)

bt.BATCH_LABEL = "tdx-lookback-200"
DB = str(BASE / "prisma" / "prisma" / "db" / "custom.db")
CHECKPOINT_FILE = str(BASE / "data" / "backfill-checkpoint-lookback.json")
CUTOFF = "2026-09-16"  # only insert bars older than the eval window (newer already present)
BATCH_SIZE = 50
FETCH_COUNT = 200


def fetch_with_retry(sym, attempts=2):
    for i in range(attempts):
        bars = bt.fetch_bars(sym, FETCH_COUNT)
        if bars:
            return bars
        time.sleep(1.0 * (i + 1))
    return []


def main():
    con = sqlite3.connect(DB)
    cur = con.cursor()
    syms = [r[0] for r in cur.execute("SELECT DISTINCT symbol FROM stock_daily_bar ORDER BY symbol")]
    names = {}
    for s, n in cur.execute(
        "SELECT symbol, name FROM stock_daily_close WHERE (symbol, tradeDate) IN "
        "(SELECT symbol, MAX(tradeDate) FROM stock_daily_close GROUP BY symbol)"
    ):
        names[s] = n or ""
    print(f"universe={len(syms)} fetch_count={FETCH_COUNT} cutoff=<{CUTOFF}", flush=True)

    ck = {"script": "backfill-tdx-lookback.py", "next_index": 0,
          "counts": {"inserted_close": 0, "inserted_bar": 0}, "failed": []}
    if os.path.exists(CHECKPOINT_FILE):
        try:
            prev = json.load(open(CHECKPOINT_FILE))
            if prev.get("script") == "backfill-tdx-lookback.py":
                ck = prev
                print(f"resuming at index {ck.get('next_index')}/{len(syms)}", flush=True)
        except Exception as e:
            print(f"checkpoint unreadable ({e}), starting over", flush=True)
    start = int(ck.get("next_index") or 0)
    now_iso = bt.fix_dt(datetime.datetime.now().isoformat())
    idx = start
    while idx < len(syms):
        batch = syms[idx:idx + BATCH_SIZE]
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
            futs = {ex.submit(lambda s: (s, names.get(s, ""), fetch_with_retry(s)), s): s for s in batch}
            by_sym = {}
            for fut in concurrent.futures.as_completed(futs):
                try:
                    sym, name, bars = fut.result()
                except Exception as e:
                    print(f"fetch err {e}", flush=True)
                    continue
                by_sym[sym] = (name, bars)
        for mysym in batch:
            name, bars = by_sym.get(mysym, (names.get(mysym, ""), []))
            kept = [b for b in bars if b["date"] < CUTOFF]
            if not bars:
                ck["failed"].append(mysym)
            ic, ib = bt.insert_bars(cur, mysym, name, kept, now_iso)
            ck["counts"]["inserted_close"] += ic
            ck["counts"]["inserted_bar"] += ib
        con.commit()
        idx += BATCH_SIZE
        ck["next_index"] = idx
        bt.save_checkpoint(CHECKPOINT_FILE, ck)
        print(f"done idx={idx}/{len(syms)} inserted_bar={ck['counts']['inserted_bar']} failed={len(ck['failed'])}", flush=True)
    con.close()
    print(f"DONE inserted={ck['counts']} failed={len(ck['failed'])}", flush=True)


if __name__ == "__main__":
    main()
