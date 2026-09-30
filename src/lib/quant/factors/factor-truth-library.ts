// P36-D：读 data/factor-truth.json（由 scripts/build-factor-truth.ts 生成）。
// 带 mtime 缓存：文件没变就不重复解析（与 regime-library 同一套路）。
import fs from "node:fs";
import path from "node:path";
import type { FactorTruthFile } from "./factor-truth-core.ts";

const FILE = path.join(process.cwd(), "data", "factor-truth.json");

let cache: { mtimeMs: number; file: FactorTruthFile } | null = null;

/** 拿不到就返回 null（页面据此如实说"没做过检验"，而不是编一个数） */
export function factorTruth(): FactorTruthFile | null {
  try {
    const st = fs.statSync(FILE);
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.file;
    const file = JSON.parse(fs.readFileSync(FILE, "utf8")) as FactorTruthFile;
    cache = { mtimeMs: st.mtimeMs, file };
    return file;
  } catch {
    return null;
  }
}
