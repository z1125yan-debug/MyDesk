// P7-⑫ 折叠面板铺开（任务1 收尾轮）的接线测试
//
// 这一轮把 9 个文件里 16 处原生 <details> 换成统一 DeskCollapse，最怕的回归有两种：
// ① 换的过程中把技术细节整块删了（任务书全局约束：不删信息，只改收纳方式）；
// ② 有人日后又写回原生 <details>，统一样式从这一刻起漂移。
// 所以这里既钉「旧结构清零」，也钉「每条被搬家的文案原文仍在」——文案是逐字从旧 summary 抄来的锚点。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
/** 去掉整行注释：注释里提到 <details> 不是违规，代码行里才是。 */
const code = (src: string) =>
  src.split("\n").filter((l) => !/^(\/\/|\*|\/\*)/.test(l.trim())).join("\n");

const MOVED: { file: string; anchors: string[] }[] = [
  { file: "src/components/desk/StepTimeline.tsx", anchors: ["AI 已完成分析 · 共", "系统预取", "模型自取"] },
  { file: "src/components/desk/DecisionCard.tsx", anchors: ["接线层登记", "这份结论的完整文字口径（与 AI 上下文共用同一份）", "分项"] },
  { file: "src/components/desk/CapabilityPanel.tsx", anchors: ["已知局限", "还缺什么", "这些结论不能用真实数据支撑"] },
  { file: "src/components/desk/EventInterpretation.tsx", anchors: ["展开完整回溯链（原始事件 → AI 提取 → AI 解释 → 状态分层）", "字段归属（内核唯一出处，页面不自己判）"] },
  { file: "src/components/desk/LifecyclePanel.tsx", anchors: ["受保护未进的归档日", "为什么一行都不动，逐条写着"] },
  { file: "src/components/desk/pages/AgentPage.tsx", anchors: ["这一格喂给模型的原文 + 模型回复原文（一字未改）", "状态与停止原因的口径（本页所有文案都来自内核同一份）", "本轮系统提示词原文（服务端给模型的，前端不另写一份）"] },
  { file: "src/components/desk/pages/ResearchPage.tsx", anchors: ["引用原文（服务端按 id 回填，前端改不了）", "回溯文本（这份报告「每句话从哪来」的完整核对串）", "台账目录（", "服务端现取"] },
  { file: "src/components/desk/QimenPanel.tsx", anchors: ["查看开源库原始输出（raw）"] },
  { file: "src/components/desk/quant/MiningTab.tsx", anchors: ["淘汰明细（", "含失败原因"] },
];

test("⑫-1 全仓组件目录零原生 <details>/<summary>：统一折叠面板是唯一的收纳方式", () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
  for (const f of walk("src/components")) {
    const rel = f.split(path.sep).join("/");
    const src = code(read(rel));
    assert.doesNotMatch(src, /<details|<summary/, `${rel} 又写回了原生 details/summary：折叠面板统一口径被破`);
  }
});

test("⑫-2 搬家不丢信息：16 处旧面板的标题原文逐条仍在，且所在文件都 import 了 DeskCollapse", () => {
  for (const m of MOVED) {
    const src = read(m.file);
    assert.match(src, /from "@\/components\/desk\/ui\/DeskCollapse"/, `${m.file} 没接 DeskCollapse`);
    for (const a of m.anchors) {
      assert.ok(src.includes(a), `${m.file} 里找不到锚点「${a}」：这条技术细节被删掉了，不是被收纳`);
    }
  }
});

test("⑫-3 StepTimeline 的流式受控语义保留：开流自动展开、流毕收起、翻转才强制对齐", () => {
  const src = read("src/components/desk/StepTimeline.tsx");
  // hooks 必须在 early-return 之前（steps 会从零到有，条件后挂 hook 就是渲染间 hook 数不一致）
  const hooksAt = src.search(/useState\(pinned\)/);
  const earlyReturn = src.search(/if \(!steps\?\.length && !warning\) return null/);
  assert.ok(hooksAt > -1 && earlyReturn > hooksAt, "useState/useEffect 被挪到 early-return 之后：React 规则违规");
  assert.match(src, /streaming === true && !!steps\?\.length/, "「流式中自动展开」的派生值还在");
  assert.match(src, /onOpenChange=\{setOpen\}/, "用户手点的出口要接回状态，否则 radix 受控会把面板焊死");
});

test("⑫-4 DeskCollapse 承诺的三件事：排印整段可替换、受控透传、琥珀警示位", () => {
  const src = read("src/components/desk/ui/DeskCollapse.tsx");
  assert.match(src, /props\.triggerClassName \?\? /, "触发器排印必须可整段顶替（?? 默认值），不许两个字号 class 叠加");
  assert.match(src, /open=\{props\.open\} onOpenChange=\{props\.onOpenChange\}/, "受控要透传给 radix，StepTimeline 这类场景靠它");
  assert.match(src, /tone === "amber"/, "警示面板走 tone，不靠 className 覆盖 border/bg");
  assert.doesNotMatch(code(src), /element-plus/, "折叠面板不许引入未安装依赖");
});
