#!/usr/bin/env python3
"""Backfill via TDX gateway (127.0.0.1:8756) - independent of user's PC.
1. BJ 352 stocks: history 2026-09-28..2026-10-14 (Yahoo has no BJ, Tencent only current day)
2. HS/SZ 5215: history 2026-09-21..2026-09-24 (to make 09-28 stats computable: prev + MA5)
Dates: Shanghai timezone (ts+8h), A-share trading days.

断点续跑 (resume-safe) 设计 —— 之前是先拉全再入库，VM 重启丢全部进度：
  * 分批处理：每批 (默认 50 只) 拉完 -> 立即 INSERT OR IGNORE -> con.commit()
    -> 再写断点文件。顺序不可反：先落库 commit，再推进断点。
    若崩在 commit 与写断点之间，重跑会重拉已入库的票，INSERT OR IGNORE
    会跳过它们（stock_daily_close 有 (symbol, tradeDate) 唯一约束，
    stock_daily_bar 主键是 (symbol, tradeDate, adjust)），不会重复、不会丢数。
  * 断点文件：data/backfill-checkpoint.json（仓库相对路径），原子写
    （tmp + os.replace + fsync），记录 phase / next_index / last_symbol /
    已入库计数 / 失败票（拉不到 = 缺就是缺，不编数据，记入 failed 供复查）。
  * 重启后读断点：BJ 阶段已完成则整段跳过，HS/SZ 从 next_index 继续；
    同一阶段内已完成的批次不再重拉。
  * 拉取失败的票不阻塞进度：记入 checkpoint failed，批次照常推进，
    避免一支坏票让续跑死循环。想重拉失败票：--reset 重新跑全量。
  * SIGTERM/SIGINT：置停标志，当前批次落库 + 写断点后干净退出，
    不丢当前批次。
"""
import argparse
import json
import os
import signal
import sqlite3
import sys
import threading
import time
import urllib.request
import datetime
import concurrent.futures
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
TDX_URL = "http://127.0.0.1:8756/rpc"
DB = str(BASE / "prisma" / "prisma" / "db" / "custom.db")
BJ_FILE = "/tmp/bj_valid.json"
CHECKPOINT_FILE = str(BASE / "data" / "backfill-checkpoint.json")
DEFAULT_BATCH_SIZE = 50
BATCH_LABEL = "tdx-2026-10-16"

_stop = threading.Event()


def _handle_stop(signum, frame):
    _stop.set()
    print(f"signal {signum}: stop requested, will exit after current batch commits + checkpoint", flush=True)


signal.signal(signal.SIGTERM, _handle_stop)
signal.signal(signal.SIGINT, _handle_stop)


def tdx_rpc(method, params, timeout=30):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(TDX_URL, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read().decode())
        if not d.get("ok"):
            raise Exception(f"TDX {method} not ok: {d}")
        return d["result"]


def to_tdx_code(mysym):
    # mysym like "600519.SH", "000001.SZ", "920001.BJ"
    code, mkt = mysym.split(".")
    if mkt == "SH":
        return f"sh{code}"
    elif mkt == "SZ":
        return f"sz{code}"
    else:
        return f"bj{code}"


def fetch_bars(mysym, count=30):
    tdx_code = to_tdx_code(mysym)
    try:
        res = tdx_rpc("bars.get", {"code": tdx_code, "period": "day", "count": count})
        bars = res.get("bars", [])
        out = []
        for b in bars:
            # b["time"] like "2026-10-15T15:00:00+08:00" (Shanghai)
            dt_str = b["time"][:10]  # YYYY-MM-DD in Shanghai (TDX time is +08:00)
            out.append({
                "date": dt_str,
                "o": float(b["open"]), "h": float(b["high"]), "l": float(b["low"]), "c": float(b["close"]),
                "v": int(float(b.get("volume_lots", 0)) * 100),  # volume_lots is in hands, *100 = shares
                "amt": float(b.get("amount", 0)),
            })
        return out
    except Exception as e:
        print(f"bars err {mysym} {e}", flush=True)
        return []


# ---------------- checkpoint ----------------

def load_checkpoint(path):
    """Return checkpoint dict or None. Corrupt / missing file -> None (start over)."""
    try:
        with open(path) as f:
            ck = json.load(f)
        if not isinstance(ck, dict) or ck.get("script") != "backfill-tdx.py":
            print(f"checkpoint {path} unrecognized, ignoring", flush=True)
            return None
        return ck
    except FileNotFoundError:
        return None
    except Exception as e:
        print(f"checkpoint {path} unreadable ({e}), starting over", flush=True)
        return None


def save_checkpoint(path, ck):
    """Atomic write: tmp + fsync + os.replace. Never leave a half-written checkpoint."""
    ck = dict(ck)
    ck["updatedAt"] = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat()
    tmp = f"{path}.tmp"
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(tmp, "w") as f:
        json.dump(ck, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def new_checkpoint():
    return {
        "script": "backfill-tdx.py",
        "phase": "bj",          # bj -> hs_sz -> done
        "next_index": 0,         # resume cursor within current phase (ordered list)
        "last_symbol": None,     # last symbol committed in current phase
        "last_dates": [],        # dates inserted for last_symbol (哪一天已入库)
        "counts": {"inserted_close": 0, "inserted_bar": 0},
        "failed": {"bj": [], "hs_sz": []},  # 拉不到的票：缺就是缺，不编，记下来供复查
        "totals": {},
        "updatedAt": None,
    }


# ---------------- DB insert (one batch, immediate commit by caller) ----------------

def fix_dt(s):
    try:
        dt = datetime.datetime.fromisoformat(s.replace(" ", "T").replace("Z", ""))
        ms = dt.microsecond // 1000
        return dt.strftime("%Y-%m-%dT%H:%M:%S") + f".{ms:03d}Z"
    except Exception:
        return datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S.000Z")


def insert_bars(cur, mysym, name, bars, now_iso):
    """INSERT OR IGNORE one symbol's bars. Returns (inserted_close, inserted_bar).
    Caller must commit. Idempotent: re-inserting the same (symbol, date) is ignored."""
    inserted_close = 0
    inserted_bar = 0
    for b in bars:
        cur.execute(
            "INSERT OR IGNORE INTO stock_daily_close (id, symbol, tradeDate, close, name, createdAt) VALUES (?,?,?,?,?,?)",
            (f"{mysym}-{b['date']}-{os.urandom(4).hex()}", mysym, b["date"], b["c"], name, now_iso))
        if cur.rowcount > 0:
            inserted_close += 1
        cur.execute(
            "INSERT OR IGNORE INTO stock_daily_bar (symbol, tradeDate, adjust, open, high, low, close, volume, amount, batch, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (mysym, b["date"], "qfq", b["o"], b["h"], b["l"], b["c"], b["v"], b["amt"], BATCH_LABEL, now_iso))
        if cur.rowcount > 0:
            inserted_bar += 1
    return inserted_close, inserted_bar


def run_phase(con, ck, phase, items, fetch_fn, filter_fn, batch_size):
    """Fetch + insert one phase in batches, checkpointing after every committed batch.

    items: ordered list of (symbol, name). Resume starts at ck['next_index'] when
    ck['phase'] == phase, else at 0. Returns when phase completes or stop requested.
    Checkpoint is advanced ONLY after the batch's DB commit."""
    total = len(items)
    if ck["phase"] != phase:
        start = 0
    else:
        start = int(ck.get("next_index") or 0)
    if start >= total:
        # Phase already complete (e.g. checkpoint says next_index == total).
        ck["phase"] = "hs_sz" if phase == "bj" else "done"
        ck["next_index"] = 0
        ck["last_symbol"] = None
        ck["last_dates"] = []
        return True
    print(f"phase {phase}: resuming at index {start}/{total} (skipping {start} already-committed)", flush=True)
    cur = con.cursor()
    now_iso = fix_dt(datetime.datetime.now().isoformat())
    idx = start
    while idx < total:
        if _stop.is_set():
            print(f"phase {phase}: stop requested at index {idx}/{total}, checkpoint kept", flush=True)
            return False
        batch = items[idx:idx + batch_size]
        # Fetch batch in parallel (fetch only, no DB access from workers).
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
            futs = {ex.submit(fetch_fn, it): it for it in batch}
            fetched = []  # (symbol, name, bars) in batch order
            by_sym = {}
            for fut in concurrent.futures.as_completed(futs):
                mysym, name, bars = fut.result()
                by_sym[mysym] = (name, bars)
            for mysym, name in batch:
                fetched.append((mysym, name, by_sym.get(mysym, (name, []))[1]))
        # Insert batch immediately, then COMMIT, then checkpoint (order matters).
        batch_dates = []
        for mysym, name, bars in fetched:
            kept = [b for b in bars if filter_fn(b)]
            if not bars:
                ck["failed"][phase].append(mysym)
            ic, ib = insert_bars(cur, mysym, name, kept, now_iso)
            ck["counts"]["inserted_close"] += ic
            ck["counts"]["inserted_bar"] += ib
            batch_dates.extend(b["date"] for b in kept)
        con.commit()
        idx += len(batch)
        ck["phase"] = phase
        ck["next_index"] = idx
        ck["last_symbol"] = batch[-1][0]
        ck["last_dates"] = sorted(set(batch_dates))
        save_checkpoint(CHECKPOINT_PATH, ck)
        print(f"phase {phase}: committed {idx}/{total} last={ck['last_symbol']} "
              f"inserted_close={ck['counts']['inserted_close']} inserted_bar={ck['counts']['inserted_bar']}",
              flush=True)
    ck["phase"] = "hs_sz" if phase == "bj" else "done"
    ck["next_index"] = 0
    ck["last_symbol"] = None
    ck["last_dates"] = []
    save_checkpoint(CHECKPOINT_PATH, ck)
    return True


# Module-level checkpoint path (patchable in tests).
CHECKPOINT_PATH = CHECKPOINT_FILE


def main(argv=None):
    global CHECKPOINT_PATH
    ap = argparse.ArgumentParser(description="TDX backfill with per-batch commit + checkpoint resume")
    ap.add_argument("--db", default=DB)
    ap.add_argument("--bj-file", default=BJ_FILE)
    ap.add_argument("--checkpoint", default=CHECKPOINT_FILE)
    ap.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    ap.add_argument("--max-symbols", type=int, default=0,
                    help="testing only: cap symbols per phase (0 = no cap)")
    ap.add_argument("--reset", action="store_true",
                    help="ignore existing checkpoint and start over (checkpoint file is overwritten)")
    args = ap.parse_args(argv)
    CHECKPOINT_PATH = args.checkpoint

    if args.reset:
        ck = new_checkpoint()
        print("checkpoint reset: starting over", flush=True)
    else:
        ck = load_checkpoint(args.checkpoint) or new_checkpoint()
        if ck.get("phase") == "done":
            print("checkpoint says done: nothing to do (use --reset to re-run)", flush=True)
            return 0
    ck.setdefault("counts", {"inserted_close": 0, "inserted_bar": 0})
    ck.setdefault("failed", {"bj": [], "hs_sz": []})

    # Load BJ list
    bj = json.load(open(args.bj_file))
    bj_items = [(f"{code}.BJ", name) for code, name, _ in bj]
    bj_items.sort()
    bj_name_map = {sym: name for sym, name in bj_items}
    print(f"BJ to backfill: {len(bj_items)}", flush=True)
    # Load HS/SZ universe from DB (distinct symbols in stock_daily_close, excluding BJ)
    con = sqlite3.connect(args.db)
    cur = con.cursor()
    cur.execute("SELECT DISTINCT symbol, name FROM stock_daily_close WHERE symbol NOT LIKE '%.BJ'")
    hs_sz = sorted(cur.fetchall())  # (symbol, name), sorted => deterministic resume order
    print(f"HS/SZ in DB: {len(hs_sz)}", flush=True)
    con.close()
    ck["totals"] = {"bj": len(bj_items), "hs_sz": len(hs_sz)}

    if args.max_symbols:
        # Testing only: cap each phase, but keep checkpoint semantics identical.
        bj_items = bj_items[:args.max_symbols]
        hs_sz = hs_sz[:args.max_symbols]
        ck["totals"] = {"bj": len(bj_items), "hs_sz": len(hs_sz)}

    con = sqlite3.connect(args.db)
    try:
        # Phase 1: BJ (all bars >= 2026-09-21)
        if ck["phase"] == "bj":
            def fetch_bj(item):
                mysym, name = item
                return (mysym, name, fetch_bars(mysym, count=40))
            ok = run_phase(con, ck, "bj", bj_items, fetch_bj,
                           lambda b: b["date"] >= "2026-09-21", args.batch_size)
            if not ok:
                return 130
        else:
            print(f"phase bj: skipped, checkpoint phase={ck['phase']}", flush=True)
        # Phase 2: HS/SZ history 09-21..09-24 only
        if ck["phase"] == "hs_sz":
            def fetch_hs(item):
                mysym, name = item
                bars = fetch_bars(mysym, count=30)
                return (mysym, name, bars)
            ok = run_phase(con, ck, "hs_sz", hs_sz, fetch_hs,
                           lambda b: "2026-09-21" <= b["date"] <= "2026-09-24", args.batch_size)
            if not ok:
                return 130
        else:
            print(f"phase hs_sz: skipped, checkpoint phase={ck['phase']}", flush=True)
    finally:
        con.close()
    print(f"Total inserted close {ck['counts']['inserted_close']} bar {ck['counts']['inserted_bar']}", flush=True)
    print(f"Failed (missing, not fabricated): bj={len(ck['failed']['bj'])} hs_sz={len(ck['failed']['hs_sz'])}", flush=True)
    print("DONE TDX backfill", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
