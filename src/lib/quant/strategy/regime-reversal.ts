// 档位 × 反转事实（服务端只读）：data/regime-reversal.json
//
// 与 regime-library 同一套读法（mtime 缓存、读失败返回 null 而不是抛）。
// 它只回答一件事：**在大盘强势/震荡/弱势时，「之前涨最猛」和「之前跌最狠」的两批票，
// 往后 5 天各怎么样**——这是档位切换条弹层里那几句话的数字出处。
//
// 纪律：
// 1) 只读本地文件，不发上游请求；数字由 scripts/build-regime-reversal.ts 从本地前复权粮仓算出，
//    谁都能重跑一遍对上（可复核）；
// 2) 文件缺失/损坏 → 返回 null，页面如实说「还没跑出来」，绝不用拍脑袋的数字顶上。

import fs from "fs";
import path from "path";
import type { RegimeReversalFile } from "./regime-switch-core.ts";

const FILE = path.join(process.cwd(), "data", "regime-reversal.json");

let cache: RegimeReversalFile | null = null;
let cacheMtimeMs = -1;

export function regimeReversal(): RegimeReversalFile | null {
  try {
    if (!fs.existsSync(FILE)) return null;
    const st = fs.statSync(FILE);
    if (cache && st.mtimeMs === cacheMtimeMs) return cache;
    const j = JSON.parse(fs.readFileSync(FILE, "utf8")) as RegimeReversalFile;
    if (!j?.byRegime) return null;
    cache = j;
    cacheMtimeMs = st.mtimeMs;
    return cache;
  } catch {
    return null;
  }
}
