// P15-R20 四模式骨架 + 八卡随模式切换 钉测。
//
// 钉的是四条最容易漂的东西：
//  1. MODE_NOTES 四档都有骨架，且每档的**硬特征词**在（研判不许下动作、深度必须写反证、
//     搜索必须挂出处与「查不到就明说」），改文案时不小心把硬约束删掉会在这里炸；
//  2. cardsForMode 每个模式都给满 8 张、标签都能在全池里找到、且 chatMode 被覆写成当前模式
//     （否则点一张卡会把用户刚选的风格悄悄切走）；
//  3. 分组不重复、不新编文案——15 张卡全部来自稳智模板池；
//  4. 接线：两个页面真的按模式取卡，ChatModeMenu 不再用硬编码面板高度（desc 变长后会翻错方向）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHAT_MODES, MODE_NOTES } from "../../src/lib/desk/modes.ts";
import { ALL_SUGGESTION_CARDS, SUGGESTION_CARDS_CORE } from "../../src/lib/desk/suggestion-cards-core.ts";
import { cardsForMode } from "../../src/lib/desk/mode-cards.ts";

const HOME = readFileSync(new URL("../../src/components/desk/pages/AiHomePage.tsx", import.meta.url), "utf8");
const ASST = readFileSync(new URL("../../src/components/desk/pages/AssistantPage.tsx", import.meta.url), "utf8");
const MENU = readFileSync(new URL("../../src/components/desk/ui/ChatModeMenu.tsx", import.meta.url), "utf8");

const ALL_MODES = ["decision", "judge", "deep", "search"] as const;

test("四档模式：界面清单 4 项、提示词骨架 4 份，键一一对应", () => {
  assert.deepEqual(CHAT_MODES.map((m) => m.key), [...ALL_MODES]);
  for (const m of ALL_MODES) {
    assert.ok(MODE_NOTES[m] && MODE_NOTES[m].length > 200, `${m} 骨架太短，多半是被改没了`);
  }
  // 每档 desc 写的是「换这一档换来什么」，不是同义反复——至少带一个图标字面量
  for (const m of CHAT_MODES) assert.match(m.desc, /^[⚡◈🧠🔎]/, `${m.key} 的 desc 丢了稳智图标`);
});

test("研判模式骨架：只给状态，硬约束里明令不许下动作", () => {
  const n = MODE_NOTES.judge;
  assert.match(n, /不回答「你该怎么办」/);
  assert.match(n, /不许出现「我建议 \/ 你应该/);
  assert.match(n, /反?对?这个定性的证据|反对这个定性的证据/, "两侧证据都要写，否则等于只挑顺边的话说");
  assert.match(n, /失效条件/);
});

test("深度思考骨架：必须单独写反证状态，不许省", () => {
  const n = MODE_NOTES.deep;
  assert.match(n, /反证状态/);
  assert.match(n, /硬要求，不许省/);
  assert.match(n, /推演链条/);
  assert.match(n, /风险清单/);
  assert.match(n, /暂无数据/, "缺数要写暂无，不许拿推断顶缺口");
});

test("实时搜索骨架：每条挂出处，一条都没查到必须明说", () => {
  const n = MODE_NOTES.search;
  assert.match(n, /已核验的信息来源/);
  assert.match(n, /<时间> <来源站点>/);
  assert.match(n, /暂无相关新闻/, "不许把数据推断包装成有消息面佐证");
  assert.match(n, /数据时间/);
});

test("cardsForMode：四档各给 8 张，全部取自稳智模板池，组内不重复", () => {
  const poolLabels = new Set(ALL_SUGGESTION_CARDS.map((c) => c.label));
  for (const m of ALL_MODES) {
    const cards = cardsForMode(m);
    assert.equal(cards.length, 8, `${m} 卡片数不是 8`);
    assert.equal(new Set(cards.map((c) => c.label)).size, 8, `${m} 组内有重复标签`);
    for (const c of cards) {
      assert.ok(poolLabels.has(c.label), `${m} 里的「${c.label}」不在模板池里（新编文案了）`);
      assert.equal(c.chatMode, m, "卡片的 chatMode 必须被覆写成当前模式，否则点卡会切走风格");
    }
  }
});

test("cardsForMode：不同模式拿到的确实不是同一批（换模式要真的换卡）", () => {
  const sig = (m: string) => cardsForMode(m as "decision").map((c) => c.label).join("|");
  const seen = new Set(ALL_MODES.map(sig));
  assert.equal(seen.size, ALL_MODES.length, "有两个模式的卡片组完全一样，等于没做分组");
});

test("全池 15 张：首页 8 张 + 隐藏 7 张，标签唯一", () => {
  assert.equal(SUGGESTION_CARDS_CORE.length, 8);
  assert.equal(ALL_SUGGESTION_CARDS.length, 15);
  assert.equal(new Set(ALL_SUGGESTION_CARDS.map((c) => c.label)).size, 15);
});

test("接线：两个页面按 store.assistantMode 取卡，不再写死首页那 8 张", () => {
  for (const [name, src] of [["AiHomePage", HOME], ["AssistantPage", ASST]] as const) {
    assert.match(src, /cardsForMode\(assistantMode\)/, `${name} 没按模式取卡`);
    assert.match(src, /useDesk\(\(s\) => s\.assistantMode\)/, `${name} 没订阅 assistantMode`);
    assert.doesNotMatch(src, /SUGGESTION_CARDS_CORE\.map/, `${name} 还在直接 map 那 8 张`);
  }
});

test("接线：卡片图标补齐到全池 15 张（换模式后新露面的卡不掉成默认图标）", () => {
  const labels = ALL_SUGGESTION_CARDS.map((c) => c.label);
  for (const [name, src, table] of [
    ["AiHomePage", HOME, /const CARD_EMOJI[^=]*=\s*\{([\s\S]*?)\n\};/],
    ["AssistantPage", ASST, /const CARD_ICONS[^=]*=\s*\{([\s\S]*?)\n\};/],
  ] as const) {
    const m = src.match(table);
    assert.ok(m, `${name} 没找到图标表`);
    for (const l of labels) assert.ok(m![1].includes(l), `${name} 图标表缺「${l}」`);
  }
});

test("模式浮层：不再用硬编码面板高度（desc 变长后靠实测翻方向）", () => {
  assert.doesNotMatch(MENU, /PANEL_H/, "面板高度不能再是估算常量");
  assert.match(MENU, /offsetHeight/, "应量真实高度");
  assert.match(MENU, /anchor\.top - h - 8/, "下方放不下要翻到按钮上方");
});
