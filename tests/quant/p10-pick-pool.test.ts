// P10 择优轮：「帮我选股」候选池 + 对话跨页留存 回归测试。
//
// 背景（对应用户所见）：
//  1) 「帮我选股」不带条件时旧口径拦停（不预取、让模型反问），纯对话端（网关无 function call）
//     更是没池没工具，模型拿快讯编票——用户结论是「还是选不出来」。本轮按参考站
//     aiwuchuan.com（其前端 bundle 实测取证：冻结候选池→Agent 择优→五段式输出→可少选可不选）
//     把链路改成：条件确定性抽取（抽不到走默认活跃池并如实标注）→ 系统现跑候选池注入 → 池内择优。
//  2) 对话页挂载即 newSession()，切个页面回来话就没了——本轮删掉，会话本来就整份在
//     zustand persist（localStorage），只有用户点「新对话」或删除才清。
// 判定全在 pick-pool-core 纯核里；跨服务层的部分用源码文本钉（与 p8-skills-loop 同法）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_PICK_CONDS, DEFAULT_PICK_LABEL, PICK_DISCIPLINE, extractPickConds,
  pickCondText, poolOriginText,
} from "../../src/lib/quant/screener/pick-pool-core.ts";

const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

// ---------- 纯核：条件抽取 ----------

test("抽取：认得的口径照抽，一条一个原话片段（可被用户核对，不是黑箱）", () => {
  const r = extractPickConds("帮我找成交额大于5亿、站上20日线、主力净流入的股票");
  assert.deepEqual(r.conds.map((c) => `${c.field}${c.op}${c.value}`), [
    "above_ma_20>=1", "amount_yi>=5", "main_net_yi>0",
  ]);
  assert.equal(r.matched.length, 3);
});

test("抽取：认不出的说法绝不硬凑（缩量回调/放量大票 → 零条件，交给默认池如实标注）", () => {
  for (const q of ["帮我选出缩量回调的股票", "有什么放量的大票", "推荐几只好的"]) {
    assert.deepEqual(extractPickConds(q).conds, [], q);
  }
});

test("抽取：均线只认目录里的周期，MA30 这种不存在的字段不产条件", () => {
  assert.deepEqual(extractPickConds("站上30日线的票").conds, []);
  assert.deepEqual(extractPickConds("站上5日线").conds, [{ field: "above_ma_5", op: ">=", value: 1 }]);
});

test("抽取：同字段重复说法只留第一条（换手率大于3 与 换手超过5 不打架）", () => {
  const r = extractPickConds("换手率大于3，换手超过5也行");
  assert.equal(r.conds.filter((c) => c.field === "turnover_rate").length, 1);
});

test("默认活跃池：全快照字段、不含断源期会整池无读数的 main_net_yi；标签写明系统默认", () => {
  const fields = DEFAULT_PICK_CONDS.map((c) => c.field);
  assert.deepEqual(fields, ["amount_yi", "change_pct", "turnover_rate"]);
  assert.ok(!fields.includes("main_net_yi"), "默认池不押注主力资金（P8/P9 实测它是最常整池无读数的字段）");
  assert.ok(DEFAULT_PICK_LABEL.includes("不是你给的条件"), "默认池标签必须自证不是用户条件");
});

test("五条择优纪律一条不少（可少选可不选 / 池序不是推荐 / 数据自主补 / 五段式 / 先报条件）", () => {
  assert.equal(PICK_DISCIPLINE.length, 5);
  const all = PICK_DISCIPLINE.join("\n");
  for (const kw of ["可以不选", "不是推荐", "五段", "失效条件", "默认口径"]) {
    assert.ok(all.includes(kw), `缺关键句：${kw}`);
  }
});

test("出身文案三分（extracted 报原话 / default 报默认标签 / model 报模型自拟）", () => {
  assert.equal(poolOriginText("default", []), DEFAULT_PICK_LABEL);
  assert.ok(poolOriginText("extracted", ["量比≥2"]).includes("量比≥2"));
  assert.ok(poolOriginText("model", ["rps_50≥90"]).includes("模型"));
  assert.ok(pickCondText({ field: "amount_yi", op: ">=", value: 2 }).startsWith("成交额(亿)≥"));
  assert.ok(pickCondText({ field: "unknown_x", op: ">", value: 1 }).startsWith("unknown_x"), "目录外字段不瞎翻译中文名");
});

// ---------- 接线：调度 / 工具 / 提示词（源码文本钉） ----------

test("接线：选股场景进自动调度，条件与出身随计划下发（intent-core/skills-core）", () => {
  const skills = readSrc("src/lib/desk/skills-core.ts");
  assert.match(skills, /scene:\s*"screener",\s*spread:\s*"once",\s*args:\s*"screener_pool"/);
  assert.ok(!/screener:\s*\{\s*skip/.test(skills), "screener 不再整场景跳过");
  const ic = readSrc("src/lib/desk/intent-core.ts");
  assert.match(ic, /case\s+"screener_pool"/);
  assert.match(ic, /pool_origin:\s*ex\.conds\.length\s*\?\s*"extracted"\s*:\s*"default"/);
  // 场景提示词吃同一份纪律定义（一份定义两处消费，不许漂移）
  assert.match(ic, /\.\.\.PICK_DISCIPLINE/);
});

test("接线：工具层空条件走默认池并如实标注，返回带条件口径与择优纪律（chat-tools）", () => {
  const src = readSrc("src/lib/desk/chat-tools.ts");
  assert.match(src, /const conds = raw\.length \? raw : DEFAULT_PICK_CONDS/);
  assert.match(src, /条件口径: poolOriginText\(origin, matched\)/);
  assert.match(src, /择优纪律: PICK_DISCIPLINE/);
  // 旧拦截话术退场：空 conditions 不再回 missing
  assert.ok(!src.includes("conditions 为空：需要至少一个"), "「帮我选股」的拦停旧口径已删");
  // 模型侧 schema 同步放宽（required conditions 摘掉，desc 说明默认池）
  assert.match(src, /不给 conditions 时按系统默认活跃池跑/);
});

test("接线：两条聊天端点的选股输出格式同步五段式（工具环 systemPrompt 与浏览器直连 prompt）", () => {
  assert.match(readSrc("src/app/api/ai/chat/route.ts"), /每只给足五段：入选理由、入场条件、仓位节奏、失效条件、主要风险/);
  assert.match(readSrc("src/lib/desk/ai.ts"), /系统默认池要说明是默认口径/);
});

// ---------- 对话跨页留存 ----------

test("对话页不再挂载即开新会话：切换页面/刷新都续着原会话，删除只认用户动作", () => {
  const page = readSrc("src/components/desk/pages/AssistantPage.tsx");
  assert.ok(
    !/useEffect\(\(\)\s*=>\s*\{\s*newSession\(\);?\s*\}/.test(page),
    "挂载即 newSession() 的旧口径已删（那是「切页面对话就没了」的直接原因）",
  );
  // 但入口不能丢：手动新对话 + 删除会话两条用户动作原样在
  assert.match(page, /onClick=\{\(\) => \{ newSession\(\); \}\}/);
  assert.match(page, /dropSession\(s\.id\)/);
  // 持久化底座在 store：sessions 整份进 zustand persist（localStorage），本轮只删拦路的那次强开
  const store = readSrc("src/lib/desk/store.ts");
  assert.match(store, /persist\(/);
  assert.match(store, /sessions:/);
  // 另一半病灶：侧栏「AI 决策」按钮旧实现点击即 newSession()（实机走查抓到：切回来变 Hello）——
  // 导航不许再碰会话，新会话只认页内「新对话」按钮。
  // P15-R3a 口径迁移：工作台按钮没了（菜单收成一级平铺），「点 AI 对话 = go(copilot) 且只 go」
  // 改钉在 nav-core 登记表上——一级项 copilot 直达，Sidebar 只会 go(entryTarget)。
  const sidebar = readSrc("src/components/desk/Sidebar.tsx");
  assert.ok(!/s\.newSession|newSession\(/.test(sidebar), "Sidebar 不再订阅 newSession（点导航不清会话）");
  const nav = readSrc("src/lib/desk/nav-core.ts");
  assert.match(nav, /label: "AI 对话", key: "copilot"/, "AI 对话一级项必须直达 copilot（旧 wb.key===\"ai\" 分支的同义）");
});
