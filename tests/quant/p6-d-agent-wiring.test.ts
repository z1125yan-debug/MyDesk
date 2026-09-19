// P6-D 接线约束测试（纯静态读源码 + 只 import 内核，node --test 可直跑：不连库、不打上游）
//
// 为什么要有这一份：agent-tools.ts / agent-run.ts 都 import 了带 @/ 别名的运行时模块，
// node --test 解析不了那些别名，所以「执行器有没有真的接上」这种事实没法靠 import 断言。
// 而 P6-D 最容易出的回归恰恰都在接线上（任务书 §四十：不许伪造工具调用）：
// ① 登记表声明了 executor 但 switch 里没有分支 ⇒ 那条工具永远 not_supported，页面却把它列成「可用」；
// ② 服务层越界写别的表 ⇒ Agent 从「只读取数」变成能改数据；
// ③ 有人给 AI 加「自己调模型 / 自己收尾」的路径 ⇒ 循环变成黑盒；
// ④ 顺手把新表塞进 P5 的清理口径 ⇒ 改了用户定的保留期。
// 这四件事在单元测试里都测不到，所以逐条钉住源码。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  TOOL_DEFS, disabledTools, enabledTools, findTool, readOnlyViolations, unaccountedTools,
} from "../../src/lib/quant/screener/agent-tools-core.ts";
import { CAPABILITIES, findCapability, readOnlyCapabilities } from "../../src/lib/quant/screener/capability-core.ts";
import { DETAIL_TABLES } from "../../src/lib/quant/screener/lifecycle-core.ts";
import { AGENT_STOP_REASONS, LOG_FIELDS, LOG_STATUSES } from "../../src/lib/quant/screener/agent-loop-core.ts";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
/** 去掉整行注释：口径说明里提到「不调模型」不是违规，代码行里才是。 */
const codeLines = (src: string) =>
  src.split("\n").filter((l) => !/^(\/\/|\*|\/\*)/.test(l.trim()));
const CORE = "src/lib/quant/screener/agent-tools-core.ts";
const EXEC = "src/lib/quant/screener/agent-tools.ts";
const RUN = "src/lib/quant/screener/agent-run.ts";
const R_RUN = "src/app/api/agent/run/route.ts";
const R_TOOL = "src/app/api/agent/tool/route.ts";
const R_FINAL = "src/app/api/agent/finalize/route.ts";
const R_TOOLS = "src/app/api/agent/tools/route.ts";
const SCHEMA = "prisma/schema.prisma";

test("§二十七 工具派生自能力登记表：没有第二条来源，也没有没归属的能力", () => {
  const readCaps = readOnlyCapabilities().map((c) => c.name).sort();
  assert.deepEqual(TOOL_DEFS.map((t) => t.name).sort(), readCaps, "工具集必须逐条等于非 mutating 的能力（多一条=白名单外，少一条=能力没登记）");
  assert.deepEqual(unaccountedTools(), [], `存在没执行器也没写原因的能力：${unaccountedTools().join("、")}`);
  assert.deepEqual(readOnlyViolations(), [], `只读边界被破坏：${readOnlyViolations().join("；")}`);
  // 明确不开放的工具必须逐条带原因（静默消失等于伪装成可用）
  for (const t of disabledTools()) {
    assert.ok(t.enabled === false);
    assert.ok(!t.executor, `${t.name} 不开放却还写着 executor`);
    assert.ok(t.limitations.length > 0, `${t.name}：不可执行的原因没随条目给出去`);
  }
});

test("§四十 不伪造工具调用：每条 enabled 工具的 executor 在 switch 里真的有分支", () => {
  const src = read(EXEC);
  const cases = new Set([...src.matchAll(/^\s*case "([^"]+)":/gm)].map((m) => m[1]));
  assert.ok(cases.size > 5, `dispatch 的 case 正则只抓到 ${cases.size} 条：本测试的匹配式随源码漂移了，必须修而不是删`);
  const listed = /export const DISPATCHED_EXECUTORS = \[([\s\S]*?)\] as const/.exec(src);
  assert.ok(listed, "DISPATCHED_EXECUTORS 清单没找到：覆盖率自检无从判起");
  const dispatchTable = new Set([...listed[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  for (const t of enabledTools()) {
    const exec = findTool(t.name)?.executor ?? "";
    assert.ok(exec, `${t.name}：enabled 却没有 executor（页面会显示成可用但一调就 not_supported）`);
    assert.ok(cases.has(exec), `${t.name} 的 executor「${exec}」在 dispatch 里没有 case ⇒ 这是假能力`);
    assert.ok(dispatchTable.has(exec), `${exec} 有 case 但没写进 DISPATCHED_EXECUTORS：自检会漏报`);
  }
  // 声明的 executor 总数与表内条目一致（多出来的 id 就是「登记了但没人用」）
  assert.deepEqual([...dispatchTable].filter((id) => !cases.has(id)), [], "DISPATCHED_EXECUTORS 里的 id 没有对应 case ⇒ 自检会把它当成已接");
  assert.deepEqual([...cases].filter((id) => !dispatchTable.has(id) && id.includes(".")), [], "有 case 却没写进 DISPATCHED_EXECUTORS：假能力自检漏报");
});

test("服务层可测性：agent-run.ts 不 import 任何 @/ 运行时模块（否则 node --test 测不到真逻辑）", () => {
  const src = read(RUN);
  const runtimeAlias = src.split("\n").filter((l) => /^import\s+(?!type)/.test(l.trim()) && l.includes('"@/'));
  assert.deepEqual(runtimeAlias, [], `运行时 @/ import 会让测试拿不到这一层：${runtimeAlias.join(" | ")}`);
  assert.match(src, /import\("\.\/agent-tools\.ts"\)\)\.runAgentTool/, "执行器只在真要取数时动态加载：这一句是注入假执行器还能跑通的前提");
  assert.match(src, /runTool\?: RunToolFn/, "执行器必须由调用方注入（否则测试只能打真实上游）");
  assert.doesNotMatch(src, /process\.env\.(OPENAI|AI)_/, "服务层不持有 AI 凭据：凭据只在客户端");
});

test("§十八 日志字段：必记项全部独立成列，事后能从 agent_tool_call 完整重建这一次调用", () => {
  const schema = read(SCHEMA);
  const model = /model AgentToolCall \{([\s\S]*?)\n\}/.exec(schema);
  assert.ok(model, "agent_tool_call 的 model 块没找到");
  const cols = new Set([...model[1].matchAll(/^\s{2}(\w+)\s+(?:String|Int|DateTime|Boolean)/gm)].map((m) => m[1]));
  // Prisma 列名用 camelCase，内核字段名用 §十八 的蛇形；只有这一处不同名，所以逐字点名而不是猜映射
  const ALIAS: Record<string, string> = { input: "inputJson" };
  const camel = (k: string) => k.replace(/_([a-z])/g, (_, c) => String(c).toUpperCase());
  for (const f of LOG_FIELDS) {
    const col = ALIAS[f] ?? camel(f);
    assert.ok(cols.has(col), `§十八 要求的 ${f} 没有独立成列（映射到 ${col} 也没有），丢掉就没法回答「刚才调用了什么」`);
  }
  assert.ok(cols.size >= 19, `调用行只有 ${cols.size} 列：§十八 要求的一次调用 19 项字段装不下`);
  // 一份映射：走一步的响应与整次运行的时间线必须由同一个 rowToLog 产出（两套映射必漂移）
  const run = read(RUN);
  assert.match(run, /call: rowToLog\(row\)/, "step 响应不再走 rowToLog ⇒ 又开始各写一套字段名");
  assert.match(run, /timeline: rows\.map\(rowToLog\)/, "timeline 不再走 rowToLog ⇒ 同上");
  assert.match(model[1], /@@unique\(\[runId, step\]\)/, "自然键必须是 (runId, step)：网络重试重发同一步不该多出一步");
  assert.match(model[1], /@@index\(\[runId\]\)/, "按 run_id 整批读调用行是这张表的主用法");
  // 状态清单不缩水：预算/缓存/协议外回复都得有各自的状态，不能压成 failed
  for (const s of ["ok", "empty", "failed", "timeout", "not_supported", "bad_params", "budget", "cached", "rejected", "invalid_directive"]) {
    assert.ok((LOG_STATUSES as readonly string[]).includes(s), `output_status 少了 ${s}`);
  }
});

test("新表不进 P5 清理口径：保留期由用户决定，未定之前一行都不删", () => {
  assert.deepEqual(DETAIL_TABLES, ["radar_finding", "global_event"], "P5 的清理范围已经定稿，P6-D 不得自行扩大");
  const lifecycle = read("src/lib/quant/screener/lifecycle-core.ts") + read("src/lib/quant/screener/lifecycle-service.ts");
  assert.doesNotMatch(lifecycle, /agent_run|agent_tool_call/, "生命周期层出现 Agent 表 ⇒ 有人在给新表定保留期，那属于用户决定");
  const run = read(RUN);
  assert.doesNotMatch(run, /deleteMany|\.delete\(/, "服务层不做删除：未定保留期前一行都不该消失");
});

test("只读边界：Agent 一层不改数据、不改公式、不写文件、不调模型", () => {
  const exec = read(EXEC);
  // 写操作的痕迹一个都不该有（落库只发生在 agent-run.ts 的两张表上）
  assert.doesNotMatch(exec, /\.create\(|\.update\(|\.upsert\(|\.delete\(|deleteMany/, "执行器层出现写库：Agent 只能读");
  assert.doesNotMatch(exec, /writeFileSync|appendFile/, "执行器层写文件：因子验证账本只能由正式验证流程写");
  for (const f of [RUN, R_RUN, R_TOOL, R_FINAL, R_TOOLS]) {
    const src = read(f);
    // 注释里允许写「/api/ai/proxy 只做文本进文本出」这类口径说明；禁的是代码行里真的出现调模型的出口
    const code = codeLines(src);
    const offenders = code.filter((l) => /ai\/proxy|fetch\(/.test(l));
    assert.deepEqual(offenders, [], `${f} 出现调模型的出口：AI 凭据只在客户端，服务端不代发（P6-D 前置审计结论）`);
    const auto = code.filter((l) => /cron|setInterval|scheduler/i.test(l));
    assert.deepEqual(auto, [], `${f} 出现定时/调度：本报告与这一步都是被客户端一步一格驱动的，不是自动跑的`);
  }
  // 写库范围：agent-run.ts 只碰自己那两张表
  const writes = [...read(RUN).matchAll(/db\.(\w+)\.(upsert|update|create|delete|deleteMany)\(/g)].map((m) => `${m[1]}.${m[2]}`);
  assert.ok(writes.length > 0, "一行写库都没有 ⇒ 这个文件不是落库层，测试前提变了");
  for (const w of writes) {
    assert.match(w, /^agent(Run|ToolCall)\./, `服务层越界写了 ${w}：只允许写 agent_run / agent_tool_call`);
  }
});

test("四个路由：状态码来自服务层的 http 字段，不再用正则猜中文；错误结构与成功同形", () => {
  for (const f of [R_RUN, R_TOOL, R_FINAL]) {
    const src = read(f);
    assert.doesNotMatch(src, /\.\s*test\(\s*(r|res)\.error/, `${f} 用正则判中文错误来定状态码：那会把「参数错」「找不到」「已收尾」压成同一个 400`);
    assert.match(src, /status:\s*(r\.http|view\.http)/, `${f} 应照服务层给的 http 回状态码`);
    assert.match(src, /export const dynamic = "force-dynamic"/, `${f} 不声明动态：读取会命中构建期缓存，回看就不是当下的库`);
  }
  assert.match(read(R_TOOL), /status: r\.http/);
  assert.match(read(R_FINAL), /status: r\.http/);
  // 502 分支的 body 与真实状态码一致：只看 body 时不会读到「400」而实际回 502
  assert.match(read(R_FINAL), /http: 502/);
  assert.match(read(R_RUN), /http: 502/);
  assert.match(read(R_TOOLS), /unimplemented_executors/, "目录页必须自检执行器覆盖：那是唯一能公开看见「假能力」的地方");
  // 收尾接口的长度上限与 P6-C 同源，不另立一份口径
  assert.match(read(R_FINAL), /MAX_RAW_CHARS/);
});

test("Agent 自己的运行记录也进了能力登记表（可被查询，且明确 mutating=false）", () => {
  const cap = findCapability("agent_run_history");
  assert.ok(cap, "P6-D 的新表没登记：Agent 无法回答「刚才那次研究调了什么」，页面也无从核对");
  assert.equal(cap?.mutating, false, "读运行记录本身不是写操作；mutating=true 会让它进不了只读白名单");
  assert.equal(cap?.availability, "db");
  assert.equal(cap?.data_status, "REAL", "调用日志是服务端真实发生过的记录；结论原文的分层在 limitations 里说明");
  assert.ok((cap?.limitations ?? []).some((l) => /AI_INTERPRETATION/.test(l)), "必须写明答案文本属 AI 解释层，不是行情事实");
  assert.ok((cap?.limitations ?? []).some((l) => /180 天|保留期/.test(l)), "必须写明这两张表不在 P5 清理口径内");
  assert.ok(enabledTools().some((t) => t.name === "agent_run_history"));
  const svc = read("src/lib/quant/screener/capability-service.ts");
  assert.match(svc, /case "agent_run_history"/, "探测层没有这条能力：能力面板会显示「未探测」而不是真实行数");
  assert.match(svc, /db\.agentRun\.count\(\)/, "探测必须真的数库里的行，不能凭文案说可用");
  assert.ok(CAPABILITIES.some((c) => c.name === "agent_run_history"));
});

test("停止原因清单不缩水：预算、重试上限、停摆、协议外、已答复都要各自有名", () => {
  // 逐字对齐内核常量（agent-loop-core.ts:86）。「超时」不在这里：它是**单次调用**的碰壁分类
  // （AGENT_FAILURE_KINDS 的 timeout），整轮停止的对应原因是 max_total_ms —— 两者不许互相冒充。
  const expected = ["answered", "max_steps", "max_tool_calls", "max_total_ms", "retry_limit", "no_progress", "invalid_directive", "not_run"];
  assert.deepEqual([...AGENT_STOP_REASONS].sort(), [...expected].sort(), "停止原因清单与测试期望不一致：页面与提示词的口径会跟着漂");
  for (const r of ["max_steps", "max_tool_calls", "max_total_ms", "retry_limit", "no_progress", "invalid_directive", "not_run"]) {
    assert.ok((AGENT_STOP_REASONS as readonly string[]).includes(r as (typeof AGENT_STOP_REASONS)[number]), `停止原因少了 ${r}`);
  }
  // 「没跑成」的原因必须能落到文字上：截断原因与停止原因是页面必须显示的两件事
  const core = read(CORE);
  assert.match(core, /SUMMARY_MAX_LEN/, "台账行长上限要有出处：不限制会把每轮提示词撑爆");
  assert.match(core, /已截断/, "截断必须留痕：悄悄截掉等于让读者以为那行本来就那么短");
});

// ---------- ④ 客户端驱动器与运行页：这一层最容易「越权」，所以逐条钉住 ----------

const CLIENT = "src/lib/desk/agent-loop-client.ts";
const PAGE = "src/components/desk/pages/AgentPage.tsx";

test("§十七 客户端驱动器不自己判预算/不自己收尾：判定权全在内核与服务端，本页只搬运", () => {
  const src = read(CLIENT);
  // 准入、记账、复校验都是服务端内核的活；客户端import 它们就等于把判据抄第二份（改了内核这里不会红）
  for (const fn of ["admitCall", "recordCall", "verifyAgentAnswer", "nextAction", "classifyDeadEnd"]) {
    assert.doesNotMatch(src, new RegExp(`\\b${fn}\\b`), `客户端自己调了 ${fn}：那会有第二份判据，内核改了页面不会跟着变`);
  }
  // 不连库、不直连接口（一律经 quant-api 的封装，状态码与 body 同形）
  assert.doesNotMatch(src, /prisma|@\/lib\/desk\/db/, "客户端层不该出现数据库：Agent 的写库路径只有那四个接口");
  assert.doesNotMatch(src, /\bfetch\(/, "客户端直接 fetch：会绕过 agentJson 的「没有 JSON 就抛」护栏，把错误页当成跑过了");
  // 停不停只看服务端给的 next_turn；本机保险只按内核硬上限推，不自立预算
  assert.match(src, /stop\.action === "stop"/, "停止条件必须读服务端的 next_turn，而不是模型说「我结束了」");
  assert.match(src, /BUDGET_HARD_CAPS\.max_steps/, "本机格数上限要从内核硬上限推：抄一个魔数就会跟预算脱钩");
  // 交给收尾的是模型原文本身，不是本页改写过的文本
  assert.match(src, /agentFinalizeApi\(\{ run_id: opts\.run_id, raw, model: ai\.model \}\)/,
    "收尾必须传模型原文：传本页加工过的文本等于替它改写结论");
});

test("§十九 循环不是黑盒：提示词由服务端逐轮给，客户端唯一自拼的那一轮也来自内核", () => {
  const src = read(CLIENT);
  assert.match(src, /step\.prompt\.turn/, "下一轮提示词要用服务端返回的那一份（它按库里的行重编，含完整 log 与台账）");
  assert.match(src, /buildAgentFinalTurnText/, "受控停止后那一轮要用内核给的「只给结论」文本");
  // 除了内核那一份，客户端不许自己拼提示词段落（那会变成第二套协议，页面说什么模型听什么，没法核对）
  assert.doesNotMatch(src, /【当前台账|【已经调用过的工具|研究问题：\$\{/, "客户端自己拼提示词段落：口径就有了第二份来源");
  // 本地解析只用于路由，判定权在服务端
  assert.match(src, /只决定|只用于/, "文件里要写清本地解析只用于路由");
  assert.match(src, /parseAgentDirective\(raw\)/, "路由决定来自对模型原文的本地解析（服务端会再解析一次同一份 raw）");
});

test("④ 运行页文案单一来源：状态口径引用内核常量，页面不抄第二份", () => {
  const page = read(PAGE);
  for (const t of ["LOG_STATUS_TEXT", "AGENT_STOP_REASON_TEXT", "OBS_KIND_TEXT", "AGENT_SYSTEM_PROMPT"]) {
    assert.match(page, new RegExp(`\\b${t}\\b`), `页面没引用 ${t}：这一层状态没有内核文案就没有解释`);
  }
  assert.match(page, /AGENT_LOOP_STATUS_TEXT/, "循环状态文案要从客户端常量表来");
  // 页面里不许重新定义这些表（重新定义 = 从这一刻起会漂）
  for (const t of ["LOG_STATUS_TEXT", "AGENT_STOP_REASON_TEXT", "OBS_KIND_TEXT", "AGENT_LOOP_STATUS_TEXT"]) {
    assert.doesNotMatch(page, new RegExp(`const ${t}\\b`), `页面里又定义了一份 ${t}`);
  }
  // 未知状态值不能被就近翻译成一句现成文案
  assert.match(page, /内核没有这条文案/, "未知的状态值要原样显示并点名，不猜它算什么");
});

test("§三十一/§三十四 页面注册可见，且把「无原生 function-calling、客户端逐格驱动、只有库里的行算数」写在页面上", () => {
  const types = read("src/lib/desk/types.ts");
  const shell = read("src/components/desk/AppShell.tsx");
  const sidebar = read("src/components/desk/Sidebar.tsx");
  assert.match(types, /\| "agent"/, "PageKey 没有 agent：hash 路由与 PAGE_TITLES 会对不上");
  assert.match(types, /agent: "[^"]+"/, "PAGE_TITLES 缺 agent：顶栏标题会是空");
  assert.match(shell, /page === "agent" && <AgentPage \/>/, "AppShell 没有分支：页面进不去");
  assert.match(sidebar, /key: "agent"/, "侧栏没有入口：读者找不到这个页面");
  const page = read(PAGE);
  assert.match(page, /function-calling/, "必须写明没有原生 function-calling（否则读者以为服务商帮忙调工具）");
  assert.match(page, /本机浏览器|客户端/, "必须写明这一格由本机浏览器逐格驱动（凭据只在浏览器）");
  assert.match(page, /agent_tool_call/, "必须写明步数与台账读自库里的行：模型自称调用过不算数");
  assert.match(page, /AI_NOT_CONFIGURED/, "AI 未配置要在页面上说出来，而不是显示一条假时间线");
  assert.match(page, /不会替你跑一轮假的|不会替你跑|不会显示一条编出来的答案/, "要写明这里不会编一轮假的循环");
});

test("④ 循环状态表与常量一一对应：不多不少，且每条都有各自的解释", () => {
  const src = read(CLIENT);
  const arr = src.match(/export const AGENT_LOOP_STATUSES = \[([\s\S]*?)\] as const/);
  const table = src.match(/export const AGENT_LOOP_STATUS_TEXT: Record<AgentLoopStatus, string> = \{([\s\S]*?)\n\};/);
  assert.ok(arr && table, "循环状态常量或文案表结构变了：这条防漂移测试要跟着改成新形状，不能删断言");
  const statusKeys = [...arr![1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
  const textKeys = [...table![1].matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(textKeys, statusKeys, "循环状态文案表与常量不是同一批：页面会有状态查无文案");
  assert.ok(statusKeys.length >= 8, `循环状态只剩 ${statusKeys.length} 项：AI 未配置/失败/保险/中止/未收尾都要各自有名`);
  const texts = [...table![1].matchAll(/^\s*[A-Z_]+:\s*"([^"]+)"/gm)].map((m) => m[1]);
  assert.equal(texts.length, statusKeys.length, "有状态的文案不是字符串字面量：页面上会显示 undefined");
  assert.equal(new Set(texts).size, texts.length, "两个状态共用同一句文案：那等于把两件事压成一件");
  // 与内核那 8 项停止原因是两套东西，测试要钉住「两套都在」
  assert.equal(AGENT_STOP_REASONS.length, 8, "内核停止原因数量变了：页面说明要跟着改");
});
