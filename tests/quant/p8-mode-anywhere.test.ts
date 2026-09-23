// P8 追加：回答风格（mode）全通道生效 — 2026-09-22
// 背景：mode 原先只有工具环（/api/ai/chat）消费，纯对话/网关端点（/api/ai/proxy）拿到就丢，
// 于是 chip 在 .env 网关通道上被整排禁用。本轮把消费方补到 proxy 路由（同一份 MODE_NOTES），
// 并解除前端禁用。这里钉的是「一份定义、两条链路都吃到、界面不再按端点脸色」。
// 纯函数用 node:test 直跑；路由/页面按结构 grep 钉（与 P8 前几轮同一手法）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHAT_MODES, MODE_NOTES, asChatMode, type ChatMode } from "../../src/lib/desk/modes.ts";
import { chatRequestBody } from "../../src/lib/desk/chat-stream-core.ts";
import { foldHistoryForGateway } from "../../src/lib/llm/model-config-core.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const proxyRoute = read("../../src/app/api/ai/proxy/route.ts");
const chatRoute = read("../../src/app/api/ai/chat/route.ts");
const aiLib = read("../../src/lib/desk/ai.ts");
const useChat = read("../../src/lib/desk/use-chat.ts");
const page = read("../../src/components/desk/pages/AssistantPage.tsx");

test("MODE_NOTES：与 CHAT_MODES 一键一句、逐句非空，四键齐全（Record<ChatMode> 编译期兜底，这里钉内容）", () => {
  const keys = CHAT_MODES.map((m) => m.key);
  assert.deepEqual(Object.keys(MODE_NOTES), keys, "风格句与模式清单必须同键同序");
  for (const k of keys) {
    assert.ok(MODE_NOTES[k as ChatMode].trim(), `${k} 的风格句不能为空`);
    assert.match(MODE_NOTES[k as ChatMode], /。$/, "风格句以句号收口：它会被拼进提示词，半截话会吞掉下一句");
  }
  // 四句原文钉死：两条链路共用这一份，改动只能发生在这里并被这两处消费方同步带到
  assert.equal(MODE_NOTES.decision, "决策模式：面向操作前的快速研判，结论前置、证据充分。");
  assert.equal(MODE_NOTES.judge, "研判模式：侧重技术结构与资金结构的客观描述，减少主观倾向。");
  assert.equal(MODE_NOTES.deep, "深度思考模式：先梳理数据，再做逻辑推演，最后给风险清单。");
  assert.equal(MODE_NOTES.search, "实时搜索模式：优先引用 market_news 返回的真实快讯，注明时间；无数据则明说。");
});

test("风格句只有一份：chat 路由不再本地抄写，两条路由都查 MODE_NOTES", () => {
  assert.match(chatRoute, /MODE_NOTES\[mode\]/, "工具环查共享表");
  assert.ok(!/decision: "决策模式：面向/.test(chatRoute), "chat 路由不得再留本地副本（抄两份必漂）");
  assert.match(proxyRoute, /MODE_NOTES\[asChatMode\(body\.mode\)\]/, "纯对话端点同样查这张表，且先过白名单");
  // 与 chat 路由既有纪律一致：body.mode 是外部输入，认不出的按默认口径答而不是静默丢风格
  assert.match(proxyRoute, /mode\?: string/, "ProxyBody 声明 mode（外部输入按 string 收，不直信类型）");
});

test("proxy 的风格件只给对话轮：不带 scene 的一次一问调用不被塞交易口径", () => {
  assert.match(proxyRoute, /const modeNote = body\?\.scene \? MODE_NOTES\[asChatMode\(body\.mode\)\] : "";/,
    "生效条件钉死为「带 scene 的对话轮」");
  // 2026-09-22 P11 口径迁移：风格件从「只有 modeNote」扩成 styleNote=[风格句, 周期句]（filter(Boolean) 拼接）。
  // 2026-09-23 P15-R12 口径迁移：网关身份卡（brief）在风格件之前独立前置，out 拼装式改写。
  // 原意图逐字不变——①风格件仍放消息数组最前（身份卡之外）；②「不带 scene 零注入」仍成立：
  // 无 scene 时 body?.scene 为假 ⇒ brief=[]，且 modeNote="" 且 horizon=null ⇒ styleNote=""，一个 system 件都不多插。
  assert.match(proxyRoute, /const out: MsgIn\[\] = \[\.\.\.brief, \.\.\.\(styleNote \? \[\{ role: "system" as const, content: styleNote \}\] : \[\]\), \.\.\.merged\];/,
    "风格件（含周期句）放在消息数组最前，且空（无 scene）时 brief 与 styleNote 双双为 [] ⇒ 一个 system 件都不多插");
  assert.match(proxyRoute, /injectSceneContext\(messages,/, "无场景轮次仍走原消息（p7 钉测形状保住，风格件在其后单独前置）");
});

test("chatRequestBody：plain 端点的 mode 留在顶层、scene 键归进 scene 对象（proxy 按这份形状读）", () => {
  const body = chatRequestBody("plain", [{ role: "user", content: "600519 怎么看" }], {
    mode: "deep", focusSymbol: "600519.SH", prevScene: "stock_analysis", run: "r-1", debug: true,
  });
  assert.equal(body.mode, "deep", "mode 是顶层键（与 /api/ai/chat 同形），不该被归进 scene");
  assert.deepEqual(body.scene, { focusSymbol: "600519.SH", prevScene: "stock_analysis" }, "场景键归进 body.scene");
  assert.equal("focusSymbol" in body, false, "scene 键不在顶层重复出现");
  assert.equal(body.run, "r-1");
  assert.equal(body.debug, true);
});

test("网关折叠层把风格件一并带进最后一条 user（doubao2API 只读 user 也吃得到风格）", () => {
  const note = MODE_NOTES[asChatMode("judge")];
  const folded = foldHistoryForGateway([
    { role: "system", content: note },
    { role: "user", content: "上一问" },
    { role: "assistant", content: "上一答" },
    { role: "system", content: "【本轮场景数据】……" },
    { role: "user", content: "今天怎么看" },
  ]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].role, "user");
  assert.ok(folded[0].content.includes(note), "风格句必须在折叠结果里，否则网关模式等于没生效");
  assert.ok(folded[0].content.includes("【本轮场景数据】"), "场景数据件同批带上（顺序纪律不变）");
});

test("客户端两条传输都带 mode：流式走 extras 顶层 spread、非流式兜底显式传", () => {
  assert.match(aiLib, /\.\.\.\(opts\?\.mode \? \{ mode: opts\.mode \} : \{\}\)/, "aiChatPlain 不带 mode 就当没选，不冒充默认值");
  assert.match(useChat, /aiChatPlain\(ai, messages, \{[^}]*mode: extras\.mode/, "兜底与流式用同一份 extras.mode");
});

test("AssistantPage：风格菜单进 composer，只剩「接口没配好」一种禁用", () => {
  // 2026-09-22 P9-经验轮口径迁移：顶栏 chip 条随居中单列改版收进 composer（共享组件 ChatModeMenu）。
  // 原意图逐字保住——①不再按端点脸色禁用；②选中态只看 mode 本身；③禁用语义只剩 configured。
  // ④「端点事实徽章不许顺手删」一条随 L2 收声改版撤销（见本 test 末注释），是本轮声明的口径变更。
  assert.ok(!/disabled=\{!configured \|\| !toolsOn\}/.test(page), "旧的端点脸色禁用已解除");
  assert.ok(!/风格项不生效/.test(page), "禁用提示文案一并撤掉（它描述的世界已经不存在了）");
  assert.match(page, /<ChatModeMenu disabled=\{!configured\} \/>/, "菜单唯一禁用条件是接口未配置");
  const menuSrc = read("../../src/components/desk/ui/ChatModeMenu.tsx");
  assert.match(menuSrc, /m\.key === mode \? "text-sky-200"/, "选中态只看 mode 本身");
  // 端点路由事实（工具环/纯对话）不再刷在顶栏：L2 收声由用户 2026-09-22「优化ui」指令背书，
  // 事实本身仍可在步骤时间线的「系统预取/模型自取」标注与调试视图里考据。
  assert.ok(!/纯对话端点（/.test(page), "顶栏徽章已随改版移除（本条是对新现实的如实登记，不是解禁）");
});
