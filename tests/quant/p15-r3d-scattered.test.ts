// P15-R3d 剩余散卡页血缘收口·回归钉。
//
// 背景（对应用户所见）：R3b/R3c 把情绪/板块/选股/因子/自选收成卡后，Research / Agent / History /
// Profile 四页还是一屏一块块散摆的小卡，看不出谁跟谁是一回事。本轮口径：
//  - 一件事一张卡——同一份研究/同一次运行/同一条存档/同一份画像，按血缘分节收进一张 LineageCard，
//    页面顶部标题进卡头、说明进 note、控制按钮进 actions，原散块降为卡内 LineageSection；
//  - 只换壳不动数据逻辑：原有的诚实缺失字符串（「—」「暂无数据」「不冒充实数」「网关未运行」…）
//    必须原样活过重构，这里逐页复钉；
//  - tone 色点承载真实状态（结论被拒=danger、样本不足=warning、高风险=danger），不是装饰；
//  - Profile 原本 local `function Section` 是卡的重定义，本轮退役换 LineageSection（漂移钉见 r3b 清单）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const RESEARCH = "src/components/desk/pages/ResearchPage.tsx";
const AGENT = "src/components/desk/pages/AgentPage.tsx";
const HISTORY = "src/components/desk/pages/HistoryPage.tsx";
const PROFILE = "src/components/desk/pages/ProfilePage.tsx";

test("ResearchPage：四块读数 + 报告 + 采集器观测 + 台账 + 缺失口径 合成一张研究卡，tone 承载真实判定", () => {
  const src = readSrc(RESEARCH);
  assert.equal(src.match(/<LineageCard/g)?.length, 1, "研究页只有一张卡");
  assert.match(src, /title=\{<span className="flex items-center gap-2"><Microscope size=\{17\}[^}]*\/> AI 市场环境研究<\/span>\}/);
  // 各散块 → 卡内小节（首节不分隔线）
  assert.match(src, /<LineageSection title="当前读数"[\s\S]*divided=\{false\}/);
  assert.match(src, /<LineageSection title="研究问题"/);
  assert.match(src, /<LineageSection title="研究报告" tone=\{repTone\}/);
  assert.match(src, /<LineageSection title="七分区明细"/);
  assert.match(src, /<LineageSection title="Tool Calls · 采集器观测" tone=\{collectorTone\}/);
  assert.match(src, /<LineageSection title=\{`台账目录/);
  assert.match(src, /<LineageSection title=\{`缺失口径/);
  // tone 是从真实状态推导的：REJECTED=danger、INTERPRETED=success，不是恒色
  assert.match(src, /const repTone: SectionTone = !rep \? "info"/);
  assert.match(src, /interpretation_status === "REJECTED" \? "danger"/);
  assert.match(src, /interpretation_status === "INTERPRETED" \? "success"/);
  assert.match(src, /\.some\(\(s\) => s\.status === "failed"\) \? "warning" : "info"/);
  // 诚实缺失原样活过重构
  assert.match(src, /缺失原因见下方「缺失口径」，不会用别的数字顶替/);
  assert.match(src, /截断条数会出现在下方「缺失口径」里（不静默丢行）/);
});

test("AgentPage：一次自主运行收成一张卡（问题→结论→步骤→台账→血缘→观测），结论 tone 跟服务端判定走", () => {
  const src = readSrc(AGENT);
  assert.equal(src.match(/<LineageCard/g)?.length, 1, "Agent 页只有一张卡");
  assert.match(src, /Agent 自主研究（只读）/);
  assert.match(src, /<LineageSection title="研究问题与预算"/);
  assert.match(src, /<LineageSection title="结论" tone=\{answerTone\}/);
  assert.match(src, /<LineageSection title=\{`步骤时间线/);
  assert.match(src, /<LineageSection divided=\{false\} title=\{`台账（/);
  assert.match(src, /<LineageSection divided=\{false\} title=\{`血缘：结论 → 台账 → 工具 → 出处/);
  assert.match(src, /<LineageSection title=\{`工具目录（/);
  assert.match(src, /<LineageSection title=\{`历史运行（库内/);
  // 结论色点承载真实状态：ACCEPTED=success / PARTIAL=warning / 其余有值=danger
  assert.match(src, /const answerTone: SectionTone = !view \? "info"/);
  assert.match(src, /answer_status === "ACCEPTED" \? "success"/);
  assert.match(src, /answer_status === "PARTIAL" \? "warning"/);
  // p6-d 红线：模型自称调用不算数，只有 agent_tool_call 库内行算数——收口不许弱化这句话
  assert.match(src, /agent_tool_call/);
  assert.match(src, /只有下面这些库里读回来的行算数/);
});

test("HistoryPage：列表收成一张卡（清空进 actions），详情收成一张卡（交易计划/快照走 StatCard，缺数显「—」不补值）", () => {
  const src = readSrc(HISTORY);
  // 列表视图 + 详情视图各一张卡
  assert.equal(src.match(/<LineageCard/g)?.length, 2, "列表页与详情页各一张卡");
  assert.match(src, /note="AI 分析的存档，点击任意记录查看完整交易详情（最多保留 100 条）"/);
  assert.match(src, /<LineageSection title=\{history\.length > 0 \? `存档记录/);
  assert.match(src, /还没有分析记录。在 AI 分析页点「开始分析」后会自动存档。/);
  // 交易计划/技术快照数字走统一 StatCard，缺数照旧显「—」
  assert.match(src, /<LineageSection title="交易计划" divided=\{false\}/);
  assert.match(src, /<LineageSection title="技术快照"/);
  assert.equal(src.match(/<StatCard/g)?.length, 2, "交易计划与技术快照各一处 StatCard 渲染");
  assert.ok(src.match(/"—"/g)?.length && src.includes('m?.entry != null ? m.entry.toFixed(2) : "—"'),
    "缺数显「—」不补值");
  // 方向标签仍从 bias / 几何关系推导，没被收口时删掉
  assert.match(src, /function directionOf/);
  assert.match(src, /m\?\.bias === "看多"/);
});

test("ProfilePage：本地 Section 卡退役，画像七块 + AI 解读合成一张卡，风险/样本色点承载真实状态", () => {
  const src = readSrc(PROFILE);
  assert.equal(src.match(/<LineageCard/g)?.length, 1, "画像页只有一张卡");
  // 原 local 卡壳不再存在（漂移钉的页内复述）
  assert.ok(!/function Section\s*\(/.test(src), "Profile 的 local Section 卡必须退役");
  assert.match(src, /<LineageSection title="资金状态"[\s\S]*divided=\{false\}/);
  assert.match(src, /<LineageSection title="技术面"/);
  assert.match(src, /<LineageSection title="板块强度"/);
  assert.match(src, /<LineageSection title="新闻&事件"/);
  assert.match(src, /<LineageSection title="历史条件概率"/);
  assert.match(src, /<LineageSection title="市场风险"/);
  assert.match(src, /<LineageSection title="AI 条件式解读"/);
  // tone 承载真实状态：高风险=danger、样本不足=warning
  assert.match(src, /tone=\{\/高\/\.test\(data\.blocks\.risk\.data\.level \?\? ""\) \? "danger" : "warning"\}/);
  assert.match(src, /sample_ok === false \? "warning" : "info"/);
  // DecisionCard（P7-④ 独立取数）仍在卡内，没被收口吞掉
  assert.match(src, /<DecisionCard symbol=\{data\.symbol\} \/>/);
  // 诚实缺失字符串原样活过重构
  assert.match(src, /以下数据块暂缺（不参与结论，不冒充实数）/);
  assert.match(src, /逐笔主动买卖：暂无数据（eltdx 网关未运行）/);
  assert.match(src, /技术指标：日K历史不足/);
  assert.match(src, /板块强度：行业未匹配到榜单/);
  assert.match(src, /无可用模型通道（浏览器未配置，且服务端 \.env 通道不可用）/);
});

test("四页都还引用统一组件、且未再抄一份卡壳（跨页一致性，与 r3b 清单互为双保险）", () => {
  for (const rel of [RESEARCH, AGENT, HISTORY, PROFILE]) {
    const src = readSrc(rel);
    assert.match(src, /from "\.\.\/ui\/LineageCard"/, `${rel} 应引用统一组件`);
    assert.ok(!/function (LineageCard|LineageSection|StatCard|Section)\s*\(/.test(src),
      `${rel} 里 local 重定义 = 组件开始漂移`);
  }
});
