const fs = require("fs");
const path = require("path");

const ROOT = "D:/Zai/kairotrend-p1";
const SRC = path.join(ROOT, "src");

// 收集所有 "use client" 的 .tsx/.ts 作为客户端入口
function findClientEntries() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(tsx?|jsx?)$/.test(e.name)) continue;
      const head = fs.readFileSync(p, "utf8").slice(0, 4000);
      if (/use client/.test(head)) out.push(p);
    }
  })(SRC);
  return out;
}

const NODE_BUILTIN = /^(fs|path|child_process|os|util|crypto|stream|http|https|net|dns|zlib|readline|worker_threads|cluster|dgram|tls|tls|url)$/;

function importsOf(file) {
  const txt = fs.readFileSync(file, "utf8");
  const specs = [];
  const re = /(?:import|export)[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(txt))) {
    const s = m[1] || m[2];
    if (s) specs.push(s);
  }
  // type-only / side-effect fine; include all
  return specs;
}

function resolveSpec(spec, fromFile) {
  if (spec.startsWith("@/")) {
    let base = path.join(SRC, spec.slice(2));
    return tryExt(base);
  }
  if (spec.startsWith(".")) {
    let base = path.resolve(path.dirname(fromFile), spec);
    return tryExt(base);
  }
  // bare -> node_module / builtin
  if (NODE_BUILTIN.test(spec)) return null;
  return null; // external
}

function tryExt(base) {
  const cands = [base + ".ts", base + ".tsx", base + ".js", base + ".jsx", path.join(base, "index.ts"), path.join(base, "index.tsx")];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

function hasFs(file) {
  const txt = fs.readFileSync(file, "utf8");
  return /from\s*["'](?:fs|path|child_process)["']|require\(["'](?:fs|path|child_process)["']\)/.test(txt);
}

const entries = findClientEntries();
const visited = new Set();
const resultChains = [];

// BFS per entry, record chain to any fs-importing file
for (const entry of entries) {
  const queue = [[entry, [entry]]];
  const seen = new Set([entry]);
  while (queue.length) {
    const [file, chain] = queue.shift();
    const specs = importsOf(file);
    for (const s of specs) {
      const r = resolveSpec(s, file);
      if (!r) continue;
      if (seen.has(r)) continue;
      seen.add(r);
      const newChain = [...chain, r];
      if (hasFs(r)) {
        resultChains.push(newChain);
      } else {
        queue.push([r, newChain]);
      }
    }
  }
}

console.log("client entries:", entries.length);
console.log("=== chains reaching a fs/path module ===");
// dedupe by leaf
const printed = new Set();
for (const ch of resultChains) {
  const leaf = ch[ch.length - 1];
  if (printed.has(leaf)) continue;
  printed.add(leaf);
  console.log("\n>>> fs module:", path.relative(ROOT, leaf));
  ch.forEach((f, i) => console.log("  ".repeat(i) + path.relative(ROOT, f)));
}
if (resultChains.length === 0) console.log("(none found by static graph)");
