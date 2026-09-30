// P36 第 0 节：界面说人话（硬约束）—— 全目录钉测
//
// 为什么单独一个文件：原来 p36-b-basis.test.ts 只钉了「分档回测推荐卡片」那一块，
// 任务书第 0 节要求的是 `src/components/**` **全量**。这次把它扫全目录。
//
// 扫什么：只扫**用户能看见的文案**——JSX 文本节点（`>文字<`）和字符串字面量。
// 不扫代码标识符、不扫注释（注释是给开发看的，不是给用户的）。
// 怎么扫：逐个文件逐行抽字面量 + 文本节点，命中黑名单就报 **文件:行 + 原文**，
//         让改的人一眼看到在哪，不用自己 grep。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** 第 0 节对照表左列（界面一律禁止）；正则项为「术语在英文单词里不算」的写法 */
const BANNED: { label: string; re: RegExp }[] = [
  { label: "MA20/MA5/…（均线编号）", re: /\bMA\d+\b/ },
  { label: "均线", re: /均线/ },
  { label: "斜率", re: /斜率/ },
  { label: "截面", re: /截面/ },
  { label: "样本外", re: /样本外/ },
  { label: "样本内", re: /样本内/ },
  { label: "置信区间", re: /置信区间/ },
  { label: "最大回撤", re: /最大回撤/ },
  { label: "超额", re: /超额/ },
  { label: "净值曲线", re: /净值曲线/ },
  { label: "反向因子", re: /反向因子/ },
  { label: "方向为负", re: /方向为负/ },
  { label: "不可成交", re: /不可成交/ },
  { label: "中位个股", re: /中位个股/ },
  { label: "单调性/单调", re: /单调/ },
  { label: "牛市", re: /牛市/ },
  { label: "熊市", re: /熊市/ },
  // IC 系列：用前后非字母的边界，避免误伤 HISTORICAL / VERDICT / department 这类
  { label: "IC", re: /(?<![A-Za-z])IC(?![A-Za-z])/ },
  { label: "RankIC", re: /(?<![A-Za-z])RankIC(?![A-Za-z])/i },
  { label: "ICIR/icIr", re: /(?<![A-Za-z])ICIR(?![A-Za-z])/i },
  { label: "因子", re: /因子/ },
];

/** 白名单：这些命中不是「给用户的界面文案」，改了反而有害 */
const ALLOW: { fileEnds: string; re: RegExp; why: string }[] = [
  // 给模型看的 prompt 块不算界面文案；模型懂术语，且输出侧另外有 E3 的纪律钉住
  { fileEnds: "LlmAnalysisPage.tsx", re: /^②|③|④|⑤|⑥|⑦|⑧|⑨|⑩/, why: "AI prompt 注入块（非界面文案）" },
  // 数据字段名（给需要复核的人在接口里对账用），出现在代码字段里不算文案
  { fileEnds: ".tsx", re: /^\s*(above_ma_|ma_struct|rankIc|icIr)/, why: "数据字段名" },
];

const COMP = path.join(process.cwd(), "src", "components");

function walk(d: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

export type JargonHit = { file: string; line: number; label: string; text: string };

/** 抽出一行里「用户看得见」的文字：字符串字面量 + JSX 文本节点 */
function visibleTextOf(raw: string): string {
  const parts: string[] = [];
  for (const m of raw.matchAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g)) parts.push(m[0].slice(1, -1));
  for (const m of raw.matchAll(/>([^<>{}]*\S[^<>{}]*)</g)) parts.push(m[1]);
  // 模板里的 ${...} 是代码（变量名/取值），不是给用户看的话
  return parts.join("  ").replace(/\$\{[^}]*\}/g, "·");
}

export function scanJargon(): JargonHit[] {
  const hits: JargonHit[] = [];
  for (const f of walk(COMP).sort()) {
    const rel = path.relative(process.cwd(), f).replace(/\\/g, "/");
    fs.readFileSync(f, "utf8").split(/\r?\n/).forEach((raw, i) => {
      const t = raw.trim();
      if (!t) return;
      // 注释是给开发看的，不是界面文案
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("*/")) return;
      if (t.startsWith("import ")) return;
      const text = visibleTextOf(raw);
      if (!text.trim()) return;
      for (const b of BANNED) {
        if (!b.re.test(text)) continue;
        if (ALLOW.some((a) => rel.endsWith(a.fileEnds) && a.re.test(raw))) continue;
        hits.push({ file: rel, line: i + 1, label: b.label, text: text.replace(/\s+/g, " ").slice(0, 160) });
      }
    });
  }
  return hits;
}

test("第 0 节钉测：src/components/** 的可见文案里不许出现任何黑话", () => {
  const hits = scanJargon();
  const shown = hits.slice(0, 300).map((h) => `  ${h.file}:${h.line}  [${h.label}]  ${h.text}`).join("\n");
  assert.equal(
    hits.length, 0,
    `界面文案里还有 ${hits.length} 处黑话（第 0 节硬约束，见 P36-8分达标任务书.md 对照表）：\n${shown}${hits.length > 40 ? "\n  …" : ""}`,
  );
});

test("第 0 节钉测：扫描器本身要抓得住（注入假文案必须命中）", () => {
  // 防止有人把黑名单改空、或 visibleTextOf 改坏，让上面那条变成永远绿的摆设
  const before = scanJargon().length;
  const probe = path.join(COMP, "__jargon_probe__.tsx");
  fs.writeFileSync(probe, 'export const X = <div>站上MA20，截面样本外超额最大回撤 IC</div>;\n');
  try {
    const after = scanJargon();
    assert.ok(after.length > before, "扫描器抓不到注入的黑话文案，钉测失效了");
    assert.ok(after.some((h) => h.file.includes("__jargon_probe__")), "注入的探针文件没被扫到");
  } finally {
    fs.unlinkSync(probe);
  }
});
