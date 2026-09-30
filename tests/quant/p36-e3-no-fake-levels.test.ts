// P36-E3：AI 不许编点位 / 不许编结论 —— 钉测注入块本身
//
// 事故根因（2026-09-29）：下发给人模的骨架里为了「示范格式」写了真实数字
// （3800–3820、3845–3860、3760–3780、成交维持 1.5–1.8 万亿），模型把这些**样例当成事实**
// 抄进结论 → 用户看到的点位是编的。更糟的是骨架里还有「原样写：决策信号：⏸ 观望」这种
// **强制固定结论**的指令：任何日子都输出同一个信号。
//
// 所以钉的不是「模型这次有没有编」（那要真跑一轮 LLM），钉的是**我们下发的字里有没有可抄的数字**。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

/** 注入块所在文件：改 prompt 只改这些地方 */
const PROMPT_FILES = ["src/lib/desk/modes.ts", "src/app/api/ai/chat/route.ts"];

/** 会被抄进结论的具体数字：4 位指数点位、区间点位、带万亿的成交额区间 */
const FAKE_LEVEL_RES = [
  /\b\d{4}–\d{4}\b/g,           // 3800–3820
  /\b\d{4}-\d{4}\b/g,           // 3800-3820
  /[\d.]+–[\d.]+\s*万亿/g,      // 1.5–1.8 万亿
  /[\d.]+-[\d.]+\s*万亿/g,
];

test("E3 钉测：注入块里不许出现任何具体的指数点位 / 成交额区间（模型会照抄）", () => {
  for (const f of PROMPT_FILES) {
    const src = read(f);
    for (const re of FAKE_LEVEL_RES) {
      const hits = [...src.matchAll(re)].map((m) => m[0]);
      assert.deepEqual(
        hits, [],
        `${f} 里还有具体数字 ${hits.slice(0, 5).join(" / ")}——那是样例不是数据，模型会当成事实抄进结论（一律改成 XXXX–YYYY 占位符）`,
      );
    }
  }
});

test("E3 钉测：不许再强制「原样写固定结论」（那等于让模型对任何日子给同一个答案）", () => {
  for (const f of PROMPT_FILES) {
    const src = read(f);
    assert.doesNotMatch(src, /原样写/, `${f} 里还有「原样写」的固定结论指令——任何日子都输出同一句是编结论`);
    assert.doesNotMatch(src, /主线：高低切换，暂未形成明确新主线/, `${f} 把某一天的结论写死成了模板`);
  }
});

test("E3 钉测：必须有「取不到就降级」的硬纪律，且降级话术就是「本轮数据不足，不给点位」", () => {
  const modes = read("src/lib/desk/modes.ts");
  assert.match(modes, /本轮数据不足，不给点位/, "没有降级话术，模型会用整数关口顶上");
  assert.match(modes, /没取到就降级/, "降级纪律没写进硬纪律里");
  // 两条：① 点位只能来自本轮真取到的数 ② 取不到就写「本轮数据不足」
  const route = read("src/app/api/ai/chat/route.ts");
  assert.match(route, /本轮数据不足，不给点位/, "研判模式收尾提醒里也要有降级话术（尾部指令遵循度最高）");
});

test("E3 钉测：占位符还在（格式示范不能整个删掉，只能把数字换成 XXXX）", () => {
  const modes = read("src/lib/desk/modes.ts");
  assert.match(modes, /XXXX/, "示范格式应该保留占位符，删光了模型就不知道要写区间");
});
