// P20 侧栏底部「最近」会话历史区：
// 用户「继续」推进稳智对齐 P1 剩余项，按 wenzhi-deep-comparison.md 里 P1 #7
// 「侧栏会话历史区：从 useDesk.sessions 读最近 5 条」落地。
//
// 三条口径钉死：
//   1. 只列有消息的会话（"新会话"骨架、被清空的会话不占位）
//   2. 最多 5 条，按 updatedAt 倒序
//   3. 点击切会话 = 切 activeSessionId + 跳到 copilot 页（对话页）
//
// 反向钉：不出现写死页 key 的旧实现，也不用 setInterval 之类的时间轮子。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const SIDEBAR = "src/components/desk/Sidebar.tsx";

test("Sidebar：从 store 订阅 sessions / activeSessionId / switchSession（三条数据源一个不少）", () => {
  const src = readSrc(SIDEBAR);
  assert.match(src, /useDesk\(\(s\) => s\.sessions\)/, "必须订阅 sessions（不订阅就是静态写死）");
  assert.match(src, /useDesk\(\(s\) => s\.activeSessionId\)/, "必须订阅 activeSessionId（判断当前激活哪条）");
  assert.match(src, /useDesk\(\(s\) => s\.switchSession\)/, "必须订阅 switchSession（点击要真正切会话）");
});

test("Sidebar：最多 3 条 + 只保留有消息的会话（骨架'新会话'不占位）", () => {
  const src = readSrc(SIDEBAR);
  assert.match(src, /messages\.length\s*>\s*0/, "必须过滤空消息会话，否则一打开就是一堆'新会话'占位");
  // 2026-09-30 同步判据：用户 9-29 拍板「只留最新 3 条」（store MAX_SESSIONS=3），旧的 5 条口径作废
  assert.match(src, /\.slice\(0,\s*3\)/, "必须限到 3 条（用户 2026-09-29 拍板：只留最新 3 条）");
});

test("Sidebar：按 updatedAt 倒序排（最近活跃的浮到最上面）", () => {
  const src = readSrc(SIDEBAR);
  // 排序：b.updatedAt - a.updatedAt 是升序反转 = 倒序
  assert.match(src, /b\.updatedAt\s*-\s*a\.updatedAt/, "排序必须按 updatedAt 倒序，不能按 createdAt 或 id");
});

test("Sidebar：点击会话 = switchSession(id) + go('copilot')（两步一个不能少）", () => {
  const src = readSrc(SIDEBAR);
  // 顺序敏感：先切会话、再跳页面（跳页面触发页面渲染，此时 activeSessionId 已切好）
  assert.match(src, /switchSession\(r\.id\)[\s\S]{0,40}go\("copilot"\)/, "onClick 里必须先 switchSession 再 go(copilot)");
  // 反向：不能出现旧的 assistant 页 key
  assert.doesNotMatch(src, /go\("assistant"\)/, "assistant 不是当前 PageKey，不许残留");
});

test("Sidebar：标题从 titleFromMessages 现算（会话被清空的 title 也要现算，不许显示'新会话'）", () => {
  const src = readSrc(SIDEBAR);
  assert.match(src, /titleFromMessages/, "标题必须从消息里现算，不能只用 s.title（'新会话'骨架不能漏出来）");
});

test("Sidebar：当前激活的会话要高亮（activeSessionId === r.id 且页面在 copilot）", () => {
  const src = readSrc(SIDEBAR);
  // 高亮条件：page === copilot 且 activeSessionId === 该会话 id
  assert.match(src, /page\s*===\s*"copilot"\s*&&\s*activeSessionId\s*===\s*r\.id/, "高亮条件：在 copilot 页且是该会话");
});

test("Sidebar：'最近'区块只在有会话时渲染（空态不占位）", () => {
  const src = readSrc(SIDEBAR);
  assert.match(src, /recent\.length\s*>\s*0/, "空态不画'最近'区块，避免一堆空标签");
});

test("Sidebar：不用 setInterval / 时间轮子（纯订阅驱动，不引副作用轮子）", () => {
  const src = readSrc(SIDEBAR);
  assert.doesNotMatch(src, /setInterval/, "近会话来自 store 订阅，不许引轮子");
});

test("Sidebar：图标语义——用 History（最近） + MessageSquare（消息条）", () => {
  const src = readSrc(SIDEBAR);
  assert.match(src, /History/, "区块头用 History 图标（稳智风格）");
  assert.match(src, /MessageSquare/, "每条会话前用 MessageSquare 图标（区分菜单项）");
});
