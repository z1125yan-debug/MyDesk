// R13 对话七天清理：整 7 天没动过的会话冷启动自动清出存档。
//
// 用户原话：「不需要省流量 这个是免费的 至于记忆你自己去解决 我同意 但是加一个七天后清理对话
// 不然太长了挤死了」——于是折叠层记忆原样保留（每轮全量带历史），只加一条留存规则。
// 口径钉三件事：①判定看「最后活跃」不看创建日（老对话今天还在用不许删）；
// ②时间戳读不出就不删（错删比漏删伤害大）；③清光也必须留一条空会话（列表永不空的旧不变量）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pruneStaleSessions, SESSION_TTL_MS, emptySession, type ChatSession } from "../../src/lib/desk/chat-core.ts";

const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_760_000_000_000; // 固定时钟：判定不许偷偷看墙上时间

function sess(id: string, updatedAt: number, createdAt = updatedAt - DAY): ChatSession {
  return { id, title: id, messages: [], createdAt, updatedAt };
}

test("TTL 常量就是七天（用户拍的是「七天」，改动必须过这条钉）", () => {
  assert.equal(SESSION_TTL_MS, 7 * DAY);
});

test("按最后活跃判定：满七天不删、超一毫秒才删（边界钉死）", () => {
  assert.deepEqual(pruneStaleSessions([sess("满7天", NOW - 7 * DAY)], NOW).map((s) => s.id), ["满7天"]);
  assert.equal(pruneStaleSessions([sess("8天前", NOW - 8 * DAY)], NOW)[0].id !== "8天前", true);
});

test("老会话今天还在用不许删：createdAt 一周前、updatedAt 刚刚 → 留", () => {
  const alive = sess("长跑会话", NOW - 60_000, NOW - 30 * DAY);
  assert.deepEqual(pruneStaleSessions([alive], NOW).map((s) => s.id), ["长跑会话"]);
});

test("混排只清躺平的，留下的顺序原样（列表口径不悄悄重排）", () => {
  const list = [sess("a新", NOW - DAY), sess("b躺", NOW - 9 * DAY), sess("c新", NOW - 2 * DAY)];
  assert.deepEqual(pruneStaleSessions(list, NOW).map((s) => s.id), ["a新", "c新"]);
});

test("时间戳读不出不删（updatedAt 坏退 createdAt，两个都坏留着）：错删比漏删伤害大", () => {
  const noUpd = { ...sess("坏时间", NOW), updatedAt: Number.NaN } as unknown as ChatSession;
  assert.deepEqual(pruneStaleSessions([noUpd], NOW).map((s) => s.id), ["坏时间"]); // createdAt 新鲜 → 退到 createdAt 判，留
  const bothBad = { ...noUpd, createdAt: undefined } as unknown as ChatSession;
  assert.deepEqual(pruneStaleSessions([bothBad], NOW).map((s) => s.id), ["坏时间"]); // 判不了 → 不删
});

test("全躺平清光时兜底一条新空会话（会话列表永不空，与 removeSession 同一不变量）", () => {
  const out = pruneStaleSessions([sess("旧1", NOW - 8 * DAY), sess("旧2", NOW - 20 * DAY)], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].messages.length, 0);
  assert.equal(out[0].updatedAt, NOW); // 兜底空会话的时间戳认注入的时钟，不偷看墙上时间
});

test("空进空出也兜底：传 [] 不会把列表清空", () => {
  assert.equal(pruneStaleSessions([], NOW).length, 1);
});

test("自定义 ttlMs 参数留给测试与将来改口（不许把七天焊死在函数体里）", () => {
  assert.deepEqual(pruneStaleSessions([sess("两小时前的", NOW - 2 * 60 * 60 * 1000)], NOW, DAY).map((s) => s.id), ["两小时前的"]);
  assert.notEqual(pruneStaleSessions([sess("两小时前的", NOW - 2 * 60 * 60 * 1000)], NOW, 60 * 60 * 1000)[0].id, "两小时前的");
});

// ---------- 接线钉：store 动作与冷启动挂载 ----------

test("store 接线：动作只调纯核+收口 activeSessionId，没清掉时不多写一次盘", () => {
  const storeSrc = readSrc("src/lib/desk/store.ts");
  assert.match(storeSrc, /pruneStaleSessions as pruneStaleCore/);
  assert.match(storeSrc, /pruneStaleChats: \(\) => set\(\(s\) => \{\r?\n        const sessions = pruneStaleCore\(s\.sessions\);/);
  assert.match(storeSrc, /if \(sessions\.length === s\.sessions\.length && sessions\.every\(\(x, i\) => x\.id === s\.sessions\[i\]\.id\)\) return \{\};/);
  assert.match(storeSrc, /activeSessionId = sessions\.some\(\(x\) => x\.id === s\.activeSessionId\) \? s\.activeSessionId : sessions\[0\]\.id/);
});

test("AppShell 冷启动挂一次（每次加载清一回，开着页面不盯时钟）", () => {
  const shellSrc = readSrc("src/components/desk/AppShell.tsx");
  // 2026-09-26 起改为「rehydrate 完成后跑一次」：prune 依赖会话列表，必须在 persist 恢复完再执行，
  // 否则会拿空 sessions 判 TTL（既白跑一次，也可能在恢复瞬间误判）。语义仍是「每次冷启动清一回」。
  assert.match(shellSrc, /if \(!hydrated\) return;[\s\S]{0,400}?useDesk\.getState\(\)\.pruneStaleChats\(\);\r?\n  \}, \[hydrated\]\);/);
});

// 纯核自己的既有语义不回归：emptySession 的兜底形状一字未动
test("兜底用的 emptySession 形状不回归（新会话标题/双时间戳同源）", () => {
  const fresh = emptySession(NOW);
  assert.equal(fresh.title, "新会话");
  assert.equal(fresh.createdAt, NOW);
  assert.equal(fresh.updatedAt, NOW);
});
