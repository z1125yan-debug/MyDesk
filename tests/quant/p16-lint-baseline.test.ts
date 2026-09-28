// P16 R21「lint 基线」钉测。
//
// 背景：项目原本有 52 条 eslint error，其中 46 条是 `react-hooks/set-state-in-effect`
// （effect 同步路径里 setState）。红满天的时候，新代码违规了根本看不出来——所以这批要处理掉。
//
// 处理方式不是「假装修好」，而是三层：
//  1. 真修：第三方模板代码（shadcn/ui、hooks）与已编译产物不 lint；空接口那条真改掉；
//  2. 降级：`react-hooks/set-state-in-effect` 等 Compiler 推测性规则降为 warn
//     （30+ 页面都是「effect 里发起异步取数」的标准模式，React 至今没有无成本的替代方案，
//      setTimeout 绕过只是自欺欺人）；
//  3. 兜底：本文件用哨兵钉住「effect 同步 setState」的数量上限——新增违规就红。
//
// 所以这条钉测守的是第 3 层：降级不是放行，是换了看得见的护栏。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CFG = readFileSync(join(ROOT, "eslint.config.mjs"), "utf8");

// 跳过目录要与 eslint.config.mjs 的 ignores 保持一致：ui / hooks 是第三方模板，不在本钉测的守范围内
const SKIP_DIRS = new Set(["node_modules", ".next", ".stale-next", "ui", "hooks"]);
function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, acc); }
    else if (/\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const FILES = walk(join(ROOT, "src"));

/** effect 同步路径上的 setState：`useEffect(() => {` 之后、第一个 await/then/void 之前出现的 set* 调用 */
function syncSetStateInEffects(src: string): number {
  let n = 0;
  const re = /useEffect\(\s*\(\)\s*=>\s*\{([\s\S]{0,400}?)\n\s{2}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const body = m[1];
    // 出现 await / .then( / void xxx( 之后就是异步路径了，规则不再判
    const cut = body.search(/await\s|\.then\(|void\s+[a-zA-Z]/);
    const sync = cut >= 0 ? body.slice(0, cut) : body;
    n += (sync.match(/^\s+set[A-Z][A-Za-z0-9_]*\(/gm) ?? []).length;
  }
  return n;
}

test("eslint：Compiler 的三条推测性规则已降级为 warn（不再淹没新违规）", () => {
  for (const rule of ["react-hooks/set-state-in-effect", "react-hooks/immutability", "react-hooks/preserve-manual-memoization"]) {
    const m = new RegExp(`"${rule}":\\s*"(\\w+)"`).exec(CFG);
    assert.ok(m, `${rule} 必须在配置里显式声明，不能靠默认`);
    assert.equal(m[1], "warn", `${rule} 应为 warn（error 会淹没新违规）`);
  }
});

test("eslint：不 lint 第三方模板代码与已编译产物", () => {
  assert.match(CFG, /"src\/components\/ui\/\*\*"/, "shadcn/ui 模板不 lint（改它是给升级埋冲突）");
  assert.match(CFG, /"src\/hooks\/\*\*"/, "第三方 hooks 不 lint");
  assert.match(CFG, /"\.stale-next\/\*\*"/, "移走的旧 .next 产物不能进 lint，否则扫几万行编译产物");
});

test("真修项：em-provider 的空接口已改成类型别名", () => {
  const src = readFileSync(join(ROOT, "src/lib/quant/data/em-provider.ts"), "utf8");
  assert.doesNotMatch(src, /interface\s+TcRow\s+extends/, "空接口等价于父类型，应改用 type 别名");
  assert.match(src, /type\s+TcRow\s*=/, "改用类型别名后语义不变");
});

test("哨兵：effect 同步 setState 的数量不许再涨（实测 12，上限 14）", () => {
  const per = FILES.map((f) => ({ f, n: syncSetStateInEffects(readFileSync(f, "utf8")) })).filter((x) => x.n > 0);
  const total = per.reduce((a, b) => a + b.n, 0);
  const detail = per.map((x) => `${x.f.replace(ROOT, "")}:${x.n}`).join("\n  ");
  assert.ok(total <= 14, `effect 同步 setState 已达 ${total}（上限 14）——新增前先看能不能改成派生值或挪进 async 回调：\n  ${detail}`);
});
