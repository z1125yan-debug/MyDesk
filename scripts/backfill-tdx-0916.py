#!/usr/bin/env python3
"""Backfill 2026-09-16/17/18 full-market daily bars via TDX (one-month backtest prep).

Reuses backfill-tdx.py helpers (tdx_rpc / fetch_bars / insert_bars / checkpoint).
Target dates only; INSERT OR IGNORE; per-batch commit + checkpoint (same order:
commit first, then checkpoint). Failures recorded, never fabricated.
Checkpoint: data/backfill-checkpoint-0916.json (separate from the main one).
"""
import json
import os
import sqlite3
import sys
import threading
import time
import datetime
import concurrent.futures
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
import importlib.util as _ilu

_spec = _ilu.spec_from_file_location("backfill_tdx", str(BASE / "scripts" / "backfill-tdx.py"))
assert _spec and _spec.loader
bt = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(bt)

bt.BATCH_LABEL = "tdx-2026-10-16-0916"
DB = str(BASE / "prisma" / "prisma" / "db" / "custom.db")
CHECKPOINT_FILE = str(BASE / "data" / "backfill-checkpoint-0916.json")
TARGET_DATES = {"2026-09-16", "2026-09-17", "2026-09-18"}
BATCH_SIZE = 50

_stop = threading.Event()


def main():
    con = sqlite3.connect(DB)
    cur = con.cursor()
    # Universe: every symbol ever seen in bars (covers listings/delistings across window).
    syms = [r[0] for r in cur.execute("SELECT DISTINCT symbol FROM stock_daily_bar ORDER BY symbol")]
    # Names: latest close row per symbol.
    names = {}
    for s, n in cur.execute(
        "SELECT symbol, name FROM stock_daily_close WHERE (symbol, tradeDate) IN "
        "(SELECT symbol, MAX(tradeDate) FROM stock_daily_close GROUP BY symbol)"
    ):
        names[s] = n or ""
    print(f"universe={len(syms)} target_dates={sorted(TARGET_DATES)}", flush=True)

    ck = bt.load_checkpoint(CHECKPOINT_FILE)
    if ck is None or ck.get("script") != "backfill-tdx-0916.py":
        ck = {"script": "backfill-tdx-0916.py", "next_index": 0,
              "counts": {"inserted_close": 0, "inserted_bar": 0}, "failed": []}
    start = int(ck.get("next_index") or 0)
    print(f"resuming at index {start}/{len(syms)}", flush=True)
    now_iso = bt.fix_dt(datetime.datetime.now().isoformat())
    idx = start
    while idx < len(syms):
        batch = syms[idx:idx + BATCH_SIZE]
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
            futs = {ex.submit(lambda s: (s, names.get(s, ""), bt.fetch_bars(s, 30)), s): s for s in batch}
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
            kept = [b for b in bars if b["date"] in TARGET_DATES]
            if not bars:
                ck["failed"].append(mysym)
            ic, ib = bt.insert_bars(cur, mysym, name, kept, now_iso)
            ck["counts"]["inserted_close"] += ic
            ck["counts"]["inserted_bar"] += ib
        con.commit()
        idx += BATCH_SIZE
        ck["next_index"] = idx
        bt.save_checkpoint(CHECKPOINT_FILE, ck)
        print(f"done idx={idx}/{len(syms)} inserted_bar={ck['counts']['inserted_bar']}", flush=True)
    con.close()
    print(f"DONE inserted={ck['counts']} failed={len(ck['failed'])}", flush=True)


if __name__ == "__main__":
    main()
