#!/usr/bin/env python3
"""Backfill 2024-2025 up-year full-market daily K via TDX.

Purpose: the 55-day backtest (2026-07-22~10-14) was a down/choppy window.
The user requires re-testing in a real up year (2024-2025) before trusting
any strategy conclusion.

Range fetched: 700 bars/symbol (reaches ~2023-11 for old listings).
Range inserted: tradeDate >= 2024-01-01 AND < 2025-09-09.
  - 2024-01-01: warmup start (decision days start 2024-09-01; MA144/RSV81/
    MACD need ~144 bars of lookback).
  - < 2025-09-09: covers decision days through 2025-08-29 PLUS the
    evaluation tail (5-day eval of the last decision day needs D+6 opens,
    i.e. through ~2025-09-08). Inserting only to 2025-08-29 would leave
    the last decision days unevaluable.
  - INSERT OR IGNORE: existing rows (2025-08-29 onward, sparse) are never
    modified; only missing rows are added. No dupes, no gaps at the junction.
Universe: DISTINCT symbol FROM stock_daily_bar, B shares excluded
  (Shanghai B 900xxx.SH, Shenzhen B 200xxx.SZ), BJ included.
  LIMITATION (survivorship): stocks delisted before the current DB universe
  was built are NOT in the universe and cannot be fetched; the up-year
  backtest therefore has survivorship bias (losers that died are missing).
  Disclosed, not hidden.
Missing data stays NULL (fetch failure -> recorded in checkpoint failed
list, never fabricated).
Checkpoint: data/backfill-checkpoint-2024-2025.json (separate file).
Small batches (25) + commit per batch + brief sleep: a parallel
mean-reversion validation task is READING this DB; keep write transactions
short so its reads are not blocked.
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

bt.BATCH_LABEL = "tdx-2024-2025"
DB = str(BASE / "prisma" / "prisma" / "db" / "custom.db")
CHECKPOINT_FILE = str(BASE / "data" / "backfill-checkpoint-2024-2025.json")
INSERT_FROM = "2024-01-01"
INSERT_TO = "2025-09-09"  # exclusive; covers eval tail of last decision day
BATCH_SIZE = 25
FETCH_COUNT = 700


def is_b_share(sym: str) -> bool:
    code = sym.split(".")[0]
    if sym.endswith(".SH") and code.startswith("900"):
        return True
    if sym.endswith(".SZ") and code.startswith("200"):
        return True
    return False


def fetch_with_retry(sym, attempts=2):
    for i in range(attempts):
        bars = bt.fetch_bars(sym, FETCH_COUNT)
        if bars:
            return bars
        time.sleep(1.0 * (i + 1))
    return []


def main():
    con = sqlite3.connect(DB, timeout=30.0)
    con.execute("PRAGMA busy_timeout = 30000")
    cur = con.cursor()
    all_syms = [r[0] for r in cur.execute("SELECT DISTINCT symbol FROM stock_daily_bar ORDER BY symbol")]
    syms = [s for s in all_syms if not is_b_share(s)]
    print(f"universe={len(all_syms)} after_b_exclusion={len(syms)} "
          f"excluded_b={len(all_syms) - len(syms)} fetch_count={FETCH_COUNT} "
          f"insert=[{INSERT_FROM},{INSERT_TO})", flush=True)

    names = {}
    for s, n in cur.execute(
        "SELECT symbol, name FROM stock_daily_close WHERE (symbol, tradeDate) IN "
        "(SELECT symbol, MAX(tradeDate) FROM stock_daily_close GROUP BY symbol)"
    ):
        names[s] = n or ""

    ck = {"script": "backfill-tdx-2024-2025.py", "next_index": 0,
          "counts": {"inserted_close": 0, "inserted_bar": 0}, "failed": []}
    if os.path.exists(CHECKPOINT_FILE):
        try:
            prev = json.load(open(CHECKPOINT_FILE))
            if prev.get("script") == "backfill-tdx-2024-2025.py":
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
            kept = [b for b in bars if INSERT_FROM <= b["date"] < INSERT_TO]
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
        time.sleep(0.5)  # yield to the parallel reader task
    con.close()
    print(f"DONE inserted={ck['counts']} failed={len(ck['failed'])}", flush=True)


if __name__ == "__main__":
    main()
