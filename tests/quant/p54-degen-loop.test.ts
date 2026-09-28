// P54 「模型重复死循环」护栏钉测（2026-09-27）
//
// 挡的是哪一个真实 bug：本机 dev server 真实发问「上证指数现在多少点？」（抓包 `q2.txt`），
// 上游（AMD 网关 DeepSeek-V4-Flash-Vision-Exp）回显完注入的数据块后，卡在一句
// 「请用自然语言散文体输出，不要用列表。」上**连续重复约 440 次**（2848 帧 / 4860 字），
// 没有结论、没有 [DONE]，一直吐到单轮 60s 超时 → 用户看到一屏重复废话 + 「AI 服务异常」。
//
// 这是模型侧采样退化，提示词压不住，所以按 answer-guard-core 的同一纪律在**输出边界**确定性截断：
//   degen-core.detectRepetition 只认两种形态（尾部连续重复 / 全篇高频重复），只截断不改写；
//   route.ts 两处接线：流式逐帧判（命中即掐断上游，不再白等超时）、非流式返回前判一次。
//
// 一把尺子：口径钉在源码/函数形状上，node --test 直跑零 IO。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { detectRepetition, degenWarning } from "../../src/lib/desk/degen-core.ts";
import { stripScaffoldEcho } from "../../src/lib/desk/answer-guard-core.ts";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

/** q2 真实形态（截短）：数据块回显 → 一句要求 → 同一句连续重复 */
const LOOP_LINE = "请用自然语言散文体输出，不要用列表。";
const Q2_SHAPE = [
  "### 市场情绪块",
  "- 情绪温度 42.2/100 · 偏冷 · 震荡行情（资金流缺读未计权，按可算项缩权）",
  "- 涨跌家数：上涨 1120 / 下跌 4306 / 平盘 143，总数 5569",
  "- 涨停 55 / 跌停 22",
  "- 风险等级：偏高",
  "",
  "---",
  "",
  "用户问的是上证指数点位，请直接给出点位并给出风险等级结论。",
  "",
  ...Array.from({ length: 60 }, () => LOOP_LINE).flatMap((l) => [l, ""]),
].join("\n");

/** 复刻 route.ts 里 createHeadGuard 的判定链（含 P54 逐帧判） */
function runHeadGuard(deltas: string[]): { text: string; warnings: string[] } {
  const RAW_FLUSH_MIN = 120;
  const RAW_FLUSH_CAP = 2000;
  let raw = "";
  let decided = false;
  let emitted = "";
  let degen: ReturnType<typeof detectRepetition> | null = null;
  const warnings: string[] = [];
  const decide = (final: boolean) => {
    if (decided) return;
    const g = stripScaffoldEcho(raw);
    if (!final && (g.text.length < RAW_FLUSH_MIN || (!raw.endsWith("\n") && raw.length < RAW_FLUSH_CAP))) return;
    decided = true;
    raw = "";
    if (g.stripped) warnings.push("已过滤模型复述的内部信号字段、自述与思维链，正文从结论开始。");
    emitted = g.text || "";
    const v = detectRepetition(emitted);
    if (v.degenerate) {
      degen = v;
      emitted = v.kept;
      warnings.push(degenWarning(v));
    }
  };
  for (const d of deltas) {
    if (degen) continue;
    if (decided) {
      const next = emitted + d;
      const v = detectRepetition(next);
      if (v.degenerate) {
        degen = v;
        warnings.push(degenWarning(v));
        if (v.kept) emitted = v.kept;
        continue;
      }
      emitted = next;
      continue;
    }
    raw += d;
    if (raw.length >= RAW_FLUSH_CAP || /\n\s*\n/.test(raw) || raw.length >= RAW_FLUSH_MIN) decide(false);
  }
  decide(true);
  return { text: emitted, warnings };
}

// ---------- 1. 判据本身 ----------

test("detectRepetition：q2 真实形态（同一句连续 60 次）判退化，只删重复、不删内容", () => {
  const v = detectRepetition(Q2_SHAPE);
  assert.equal(v.degenerate, true, "重复死循环没判出来");
  assert.equal(v.count >= 4, true, `重复次数统计不对：${v.count}`);
  assert.equal(v.repeated, LOOP_LINE);
  // 口径：保留被重复那一行的**第一份**（那可能是模型真正想说的话），只砍后面的尾巴
  assert.equal(v.kept.split("\n").filter((l) => l.trim() === LOOP_LINE).length, 1, "kept 里保留了不止一份重复行");
  assert.equal(v.kept.includes("### 市场情绪块"), true, "循环之前的正文被误删了");
});

test("detectRepetition：正常长答案不判退化（分节 / 表格 / 短句混合）", () => {
  const body = [
    "📌 **一句话定性：** 不是现价追买的时点。",
    "",
    "## 📊 当前状态：反弹遇阻",
    "",
    "| 项目 | 读数 | 含义 |",
    "|---|---|---|",
    "| 动态市盈率 | 约 101 倍 | 估值不便宜 |",
    "",
    "- 🟢 **回踩型（更稳）：** 回踩 37.5–38.4 元一带。",
    "- 🔵 **突破型（右侧）：** 放量站上 40.2–40.6 元。",
    "",
    "以上内容仅供参考，不构成投资建议。",
  ].join("\n");
  assert.equal(detectRepetition(body).degenerate, false);
});

test("detectRepetition：分割线 / 项目符号这类短行重复不算退化（minLineLen 护住）", () => {
  const body = ["## A", "---", "正文一。", "---", "正文二。", "---", "正文三。", "---", "正文四。"].join("\n");
  assert.equal(detectRepetition(body).degenerate, false);
});

test("detectRepetition：同一行出现很多次但篇幅占比不高 → 不算（防误伤）", () => {
  const pad = Array.from({ length: 40 }, (_, i) => `第 ${i} 行是一段正常的长正文，讲的是完全不同的内容。`).join("\n");
  const body = `${pad}\n**风险提示：** 注意仓位。\n`.repeat(3);
  assert.equal(detectRepetition(body).degenerate, false);
});

test("detectRepetition：全篇高频重复也能抓到（不要求连续）", () => {
  const line = "这一段话在答案里被反复写了很多很多遍。";
  const body = Array.from({ length: 14 }, () => line).join("\n");
  const v = detectRepetition(body);
  assert.equal(v.degenerate, true);
  assert.equal(v.count >= 12, true);
});

test("detectRepetition：没判退化时 kept 就是原文（不改写、不裁剪）", () => {
  const body = "**结论：** 偏弱。\n\n再看资金面。";
  assert.equal(detectRepetition(body).kept, body);
});

test("degenWarning：留痕要带被重复的那句与次数（不静默丢内容）", () => {
  const w = degenWarning({ degenerate: true, kept: "", repeated: LOOP_LINE, count: 440 });
  assert.match(w, /重复输出/);
  assert.match(w, /440/);
  assert.ok(w.includes(LOOP_LINE.slice(0, 10)));
});

// ---------- 2. 流式接线：用户看到什么 ----------

test("逐字流：q2 形态（回显 + 重复）——回显一个字都不许漏，重复只留一份", () => {
  const deltas = Q2_SHAPE.match(/[\s\S]{1,7}/g) ?? [];
  const { text, warnings } = runHeadGuard(deltas);
  assert.equal(text.includes("### 市场情绪块"), false, "注入块回显漏到用户界面");
  assert.equal(text.includes("用户问的是"), false, "指令回显漏到用户界面");
  assert.equal(text.split("\n").filter((l) => l.trim() === LOOP_LINE).length <= 1, true, "重复废话漏了不止一份");
  assert.equal(warnings.length > 0, true, "剥了/截断了必须留痕");
});

test("逐字流：退化循环之前有真正文时，正文保留、重复只留一份", () => {
  const deltas = [
    "## 📊 结论\n\n上证 3888.37 点，跌 1.22%，偏冷。\n\n",
    ...Array.from({ length: 30 }, () => `${LOOP_LINE}\n\n`),
  ];
  const { text, warnings } = runHeadGuard(deltas);
  assert.equal(text.includes("3888.37"), true, "循环之前的真正文被吞掉了");
  assert.equal(text.split("\n").filter((l) => l.trim() === LOOP_LINE).length <= 1, true, "重复废话漏了不止一份");
  assert.equal(warnings.some((w) => w.includes("重复输出")), true, "退化截断没留痕");
});

test("逐字流：整轮都在重复 → 只留一份，不把几十遍重复放出去", () => {
  const deltas = Array.from({ length: 40 }, () => `${LOOP_LINE}\n\n`);
  const { text, warnings } = runHeadGuard(deltas);
  assert.equal(text.split("\n").filter((l) => l.trim() === LOOP_LINE).length, 1, `重复残余：${text.length} 字`);
  assert.equal(warnings.some((w) => w.includes("重复输出")), true);
});

// ---------- 3. 源码形状钉 ----------

test("route.ts：流式与非流式两条传输都接了 detectRepetition（不许一条查一条不查）", () => {
  const src = read("src/app/api/ai/chat/route.ts");
  assert.match(src, /import \{ detectRepetition, degenWarning, type DegenVerdict \} from "@\/lib\/desk\/degen-core";/);
  assert.equal((src.match(/detectRepetition\(/g) ?? []).length >= 3, true, "流式逐帧 / 头部判定 / 非流式 三处至少要各判一次");
  assert.match(src, /if \(degen\) return; {3}\/\/ 已判退化：循环尾巴一律不发/, "流式转发里没有退化短路");
  assert.match(src, /return \{ kind: "ok", text: roundText, finishReason: "degenerate", calls: \[\] \};/, "掐断上游没走「保有截断正文」这条路");
});

test("route.ts：退化掐断的轮次不算「上游没正常收尾」（原因已由那条 warning 说清）", () => {
  const src = read("src/app/api/ai/chat/route.ts");
  assert.match(src, /if \(!sawDone && !finishReason && !degen\) \{/, "退化轮次还在报「上游未正常收尾」，两条留痕会互相打架");
});
