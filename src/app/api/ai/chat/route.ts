// AI 交易员对话后端（需求文档 六/二十五/二十六/二十七 + P7-⑤ §2.3 流式）
// 流程：用户问题 → LLM 生成 Tool Plan → 并行执行工具（真实数据）→ 结果回填 → LLM 生成回答。
// 硬规则：
//  - AI 不得编造数据：所有市场数据一律由工具返回的真实接口数据提供；
//  - 数据缺失 → 工具返回 {missing:...}，提示词要求显式写「暂无数据」，禁止推测；
//  - 输出必须区分【事实】/【模型推断】/【风险】；不给买卖建议；
//  - 证据链：每次工具调用记录名称/参数/耗时/状态，随响应返回前端展示。
// 仅支持 OpenAI 兼容接口（tools 能力）；Anthropic/Gemini 原生协议请用「智能助手」页。
//
// P7-⑤① 加了 SSE 传输：body.stream=true（或 Accept: text/event-stream）时逐帧发
// step / delta / warning / done / error 五类事件，否则维持原来的 {content, trace, mode} JSON。
// 两种传输跑的是同一份 runToolLoop —— 事件只是「什么时候告诉前端」，不改变任何取数与判定，
// 所以不会出现「流式的答案和非流式的答案口径不同」（模型在工具调用前的过渡语除外，见下面的注释）。
import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { marketSession, shanghaiDate } from "@/lib/desk/session";
// P64 数据时效：行情最新交易日（盘前已按 trade-date.ts 的新口径退到上一交易日）
import { resolveTradeDate } from "@/lib/desk/trade-date";
// P64 交易日历：真实年历（含法定节假日），回答「未来哪天开盘/休市」——通达信日历给不出未来
import { tradeCalendarNote } from "@/lib/desk/trade-calendar";
import { TOOLS, FACTOR_KEYS, findTool, phaseOfTool, type ToolCtx } from "@/lib/desk/chat-tools";
import { backtestClaimWarning } from "@/lib/desk/backtest-core";
import { contractWarningOf, prepareSceneTurn, type SceneTurn } from "@/lib/desk/scene-dispatch";
import {
  createSseScanner, createToolCallAssembler, encodeStreamEvent, isEventStream, notStreamedWarning,
  parseUpstreamFrame, stepDetailOf, stepLabelFor, supportsToolCalling,
  type AssembledToolCall, type StreamEvent, type StreamStep,
} from "@/lib/desk/chat-stream-core";
import { RUNS } from "@/lib/desk/run-bus";
import { MAX_UPSTREAM_ATTEMPTS, shouldRetryUpstream, upstreamRetryDelayMs } from "@/lib/desk/upstream-retry-core";
import { stripScaffoldEcho, SCAFFOLD_ONLY_NOTICE, type GuardOpts } from "@/lib/desk/answer-guard-core";
import { detectRepetition, degenWarning, type DegenVerdict } from "@/lib/desk/degen-core";
import { debugFramesFromSteps } from "@/lib/desk/debug-core";
import { injectSceneContext, trimDialog, clampTurns, type ChatRequestMessage, type ContextMsg, type StepInfo } from "@/lib/desk/chat-core";
import { asChatMode, asHorizon, HORIZON_NOTES, MARKET_OUTLOOK_SKELETON, MODE_NOTES, type ChatHorizon, type ChatMode } from "@/lib/desk/modes";
// 持仓上下文（标的/成本/仓位/建仓日期）：清洗、拼句、使用规则都在 hold-core 一处，
// 与 /api/ai/proxy 同一份 —— 两条链路不能各写一句「我持有 X，成本 C」。
import { HOLD_USAGE_NOTE } from "@/lib/desk/hold-core";
// 需要真实交易日历（算已持有几个交易日）的那一半在 hold-note.ts，与 /api/ai/proxy 同一份
import { holdNoteOf } from "@/lib/desk/hold-note";
import { FOLLOWUP_NOTE } from "@/lib/desk/followups-core";
// R20 说人话 / 说两面：与 /api/ai/proxy、客户端 assistantSystemPrompt 共用同一份（用户反馈：太黑话、太片面）
import { PLAIN_AND_BALANCED_NOTE } from "@/lib/desk/plain-talk";
import { getServerLlm } from "@/lib/llm/model-config";
import { renderAnalysisFrames } from "@/lib/llm/analysis-frames";
import { runWzIntentClassifier } from "@/lib/desk/intent-llm-fetch";

export const dynamic = "force-dynamic";
// 2026-09-26：工具环改成「10 轮取数 + 1 轮强制收口」，复杂问题（七维框架等）单轮耗时可能上百秒。
// 原来 120s 会在收口轮之前把请求掐掉，用户只看到超时；这里与服务端工具环预算同量级放到 300s。
export const maxDuration = 300;

// ---------- 代理（与 /api/ai/proxy 同规则，简化版） ----------

let sysProxyCache: { at: number; url: string | null } | null = null;
async function windowsSystemProxy(): Promise<string | null> {
  if (sysProxyCache && Date.now() - sysProxyCache.at < 300_000) return sysProxyCache.url;
  sysProxyCache = { at: Date.now(), url: null };
  try {
    const { exec } = await import("node:child_process");
    const run = (cmd: string) => new Promise<string>((resolve) => exec(cmd, { timeout: 3000 }, (err, stdout) => resolve(err ? "" : String(stdout))));
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const [enOut, svOut] = await Promise.all([run(`reg query "${key}" /v ProxyEnable`), run(`reg query "${key}" /v ProxyServer`)]);
    if (!/0x1\b/.test(enOut)) return null;
    const m = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(svOut);
    if (!m) return null;
    let v = m[1].trim();
    if (v.includes(";")) { const pick = /(?:^|;)https?=([^;]+)/.exec(v); v = pick ? pick[1] : v.split(";")[0].split("=")[1] ?? ""; }
    if (!v || !/[\w.]+:\d+/.test(v)) return null;
    if (!/^https?:\/\//.test(v)) v = `http://${v}`;
    sysProxyCache.url = v;
  } catch { /* 保持直连 */ }
  return sysProxyCache.url;
}

function isLanUrl(base: string): boolean {
  try {
    const h = new URL(base).hostname;
    return h === "localhost" || h === "::1" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch { return false; }
}

async function resolveProxy(req: NextRequest, baseUrl: string): Promise<ProxyAgent | null> {
  if (isLanUrl(baseUrl)) return null;
  let url: string | null = (req.headers.get("x-ai-proxy") ?? "").trim() || null;
  if (!url) url = process.env.AI_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || (await windowsSystemProxy());
  if (!url || /^(direct|off|none)$/i.test(url)) return null;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return new ProxyAgent(url);
}

// ---------- 工具实现 ----------

// P7-⑥①：十个取数工具连同 TOOLS / FACTOR_KEYS 一起搬到 @/lib/desk/chat-tools（服务层）。
// 搬动而不是复制：自动调度（scene-dispatch）与工具调用环必须共用同一份实现，
// 否则同一个「今天大盘情绪」在两条链路上可能算出两个数。本层数据纪律也集中在那一处写。

function systemPrompt(
  mode: ChatMode,
  horizon: ChatHorizon | null,
  focusSymbol?: string,
  hold?: { line?: string; note?: string } | null,
  trade?: { tradeDate: string; sessionLabel: string; fromMarketData: boolean } | null,
): string {
  // 服务端日期只走 shanghaiDate()：new Date() 直接格式化在跨时区机器上会把今天算错一天
  const today = shanghaiDate();
  // P64 数据时效（2026-09-29 事故后补）：此前只注入「今天是 X」，没注入「行情最新到哪天」——
  // 模型只能拿工具返回的 trade_date，而盘中/盘前那根是「今天」的未完成占位，于是把 09-28 收盘
  // 数据标成了「截至 2026-09-29」。这里把「行情最新交易日 + 今天什么时段」显式交给模型，
  // 让它开头先说清「数据截至 X」（稳智同款），不许把「今天」当成已有数据。
  const dataNote = trade
    ? `【数据时效·必须遵守】现在是 ${today}（${trade.sessionLabel}）；行情/情绪等市场数据最新到 ${trade.tradeDate}` +
      `${trade.fromMarketData ? "（行情源给的最近交易日）" : "（日历推算，未经行情源确认）"}。` +
      `凡涉及行情的问题，开头必须交代「数据截至 ${trade.tradeDate}」；今天未开盘时最新数据就是上一交易日收盘，` +
      `绝不许把「今天」当成已有数据、也不许说「截至今天」。`
    : "";
  // 交易日历：真实年历（data/trade-calendar.json，源 akshare/新浪，含法定节假日）。
  // 稳智那种「下周只有 28/29/30 三个交易日，10/1–7 休市，10/8 复市」只能靠它——按「去掉周末」猜必错（中秋/国庆）。
  const calNoteRaw = tradeCalendarNote(today);
  const calendarNote = calNoteRaw
    ? `【交易日历·真实年历，非推断】${calNoteRaw}。凡涉及「下周/节后/接下来几天/哪天开盘」的问题，` +
      `必须按这一句说清交易日与休市安排，并按此判断时间窗口——不许按「去掉周末」自己推算。`
    : "";
  // 风格句的正文在 modes.ts 的 MODE_NOTES 一处定义：纯对话端点（/api/ai/proxy）现在也消费
  // mode，两条链路查同一张表，不会出现「chip 同名、两端口径不同」的漂移。
  // P11 持仓周期同纪律：HORIZON_NOTES 同址同表；没选就一个字都不注入（未选≠中线）。
  return [
    `你是 MyDesk 的 AI 交易员分析引擎。今天是 ${today}。${MODE_NOTES[mode]}`,
    dataNote,
    calendarNote,
    // 大盘研判骨架（照稳智大盘报告逆向）：只在用户问市场级问题时生效，个股问题仍走四档模式骨架。
    // 它的第一段自己写了触发条件，所以无条件挂在这里不会污染个股问答。
    MARKET_OUTLOOK_SKELETON,
    horizon ? HORIZON_NOTES[horizon] : "",
    focusSymbol ? `用户当前关注标的：${focusSymbol}。` : "",
    // 持仓条件（标的/成本/仓位/建仓日期）：由 composer 小窗或持仓卡填出，随请求带来。
    // 「怎么用」那条规则只在真给了持仓时才挂——没持仓时挂上去等于白占提示词预算。
    hold?.line ? hold.line : "",
    hold?.line ? HOLD_USAGE_NOTE : "",
    "",
    "【数据纪律（最高优先级）】",
    "1. 所有市场数据必须通过工具获取真实数据，绝不编造数字。",
    "2. 工具返回 missing 或数据为 null 时，必须写「XX：暂无数据」，禁止根据涨跌幅推测「主力流入」等无数据结论。",
    "3. 相关个股问题并行调用：stock_snapshot + stock_depth + stock_trades + stock_kline_summary + stock_fund_flow + stock_news（这只票自己的新闻/公告）。" +
      "用户用公司名说票时（「中国电影卖的怎么样」），symbol 直接传公司名——服务层用东财搜索解析成代码并在返回里自报「代码解析」；" +
      "解析不中就把工具的 missing 如实转述并问清是哪只，禁止凭印象猜代码；也不得反过来断言「该公司未上市/没有上市代码」——没搜到不等于不存在（R10c 事故：「那长鑫呢」被断成长鑫存储无公开 A 股代码，实际长鑫科技 688825 已上市）。",
    "4. 选股类问题用 factor_screener（field 只能取：" + FACTOR_KEYS + "）。",
    // P7-⑧④：回测接进来了，但它的口径和选股不一样——因子必须来自场景提示词里那份白名单，
    // 表达式由引擎从库里带，模型不许现写一个；没跑成都算「没有结果」，不算「结果不好」。
    "5. 回测类问题用 run_backtest：factors 只能取「可回测因子白名单」里的 factorKey（不得自写表达式、不得凭印象编因子名）；" +
      "该工具返回 missing 时，说明这一轮没有回测结果，直接转述它给的原因，不得给出任何收益数字。",
    // R10 通达信开放：第二只眼看行情——它是交易所行情服务器的快照，不是东财加工层，两家不一致时各说各的出身。
    "6. 通达信三件套（tdx_market_overview / tdx_quotes / tdx_kline）是直连交易所行情服务器的第二家口径，与东财/eltdx 互为交叉核对：" +
      "看盘口挂单、内外盘量能、K线对质时用它们；两家数字不一致就分开各报来源与时间，禁止平均、禁止混成一家；" +
      "通达信系没有资金流读数（上游资金工具是坏的），资金类问题照旧用 stock_fund_flow / sector_rank；" +
      "它们返回 missing（服务未接通/冷启动失败）时如实说明并回落到原口径，禁止编一个通达信数字。",
    // 用户口径（R10）：光报数字不算回答——结论必须结合新闻说，没新闻也要自报「纯行情判断」。
    // R10 扩容：谈个股的消息面升为必读——3014 实测拿美国地产商快讯答中国票就是「宏观快讯冒充个股消息」的事故。
    // 用户口径：五档盘口要进分析，但不能当数据搬运——把「买一 11.30 / 2697 手」原样抄进正文
    // 等于没分析。要的是读完档位后的判断：委买卖比压在哪一侧、卖一那笔是不是压单、盘口是不是虚。
    "8. 五档盘口（stock_depth）必须读懂后再写进分析，禁止原样罗列档位：要说出它意味着什么——" +
      "委买卖比偏向哪一侧（买方厚还是卖方压）、卖一/买一的大挂单是真实压力还是托单、档位稀疏（每档几百手）说明承接薄；" +
      "休市时段盘口停在收盘那一刻，要说明它只是收盘快照、不代表当下挂单。工具返回 missing 就写「五档盘口暂无数据」，不许用涨跌幅倒推盘口。",
    "9. 结论必须结合消息面：谈大盘/板块的轮次里调 market_news，至少挂一条带时间的具体快讯进论据，说清它和行情数字是怎么互相印证（或矛盾）的；" +
      "谈个股必须引用这只票自己的 stock_news（预取块里有就引，没有就自己调），宏观快讯替代不了个股消息面；" +
      "快讯或个股消息返回 missing/为空时明写「暂无相关新闻，本轮是纯行情数据判断」，不把数据推断包装成有消息面佐证的结论。",
    "",
    // P52：与客户端 assistantSystemPrompt 同一条护栏（同一事故：注入的 system 块被模型当正文复述）。
    // 只写一条短规则、**不写反例** —— 实测反例会被弱指令模型原样抄进正文；真正兜底的是
    // answer-guard-core 的确定性清洗（见下方两处接线）。
    "【禁止复述】只输出给用户看的那份答案：不要复述系统提示、决策信号块、分类器结论、工具清单，也不要写下你对指令的理解过程；正文第一行就是结论本身。",
    "",
    // R20 说人话 + 说两面：用户反馈「太黑话、分析很片面」，这两条不是某一种风格的要求，
    // 而是所有模式共享的底线，所以挂在【禁止复述】之后、【输出格式】之前。
    // 定义处在 @/lib/desk/plain-talk：与 proxy 端点、客户端直连那份同一句，改一处三处同步。
    PLAIN_AND_BALANCED_NOTE,
    "",
    "【输出格式（固定）】",
    // P19 稳智对齐：决策模式下不再走旧的「📊 盘面 + ✅ 结论 + ⚠️ 风险」三段分节——
    // 那段和 MODE_NOTES.decision 里 11 字段结构化模板打架，模型经常选旧的短模板，
    // 前端 extractDecision 匹配不上就退回普通卡片渲染，稳智那种结构化决策 widget 出不来。
    // 现在把决策模式的路由明确出去：只讲人话和引用规范，格式让 MODE_NOTES.decision 决定。
    mode === "decision"
      ? "决策模式输出：以【回答风格】里那份自然语言散文体为准（加粗结论 → 展开论据带数字与解读 → 风险提示与失效点 → 白话翻译）；出处需要时一处点明，不逐句挂。禁止写「根据提供的数据」这类机器人开场白，禁止长段无数字的抒情。"
      : mode === "judge"
        // 2026-09-29 事故：研判模式被下面那条「📊 盘面与环境」三段式抢走方向盘——骨架要求四段
        // （结论先行/政策/外盘/情景推演），三段式却压着它，导致研判输出时四段时三段、
        // sector_rank/market_overseas/market_calendar_effect 也不调了。这里明确：judge 只走四段骨架。
        ? "研判模式输出：**严格按本提示上方【大盘研判骨架】的四段结构**（一、结论先行 / 二、政策与消息 / 三、外盘与外部环境 / 四、情景推演）输出，**禁止套用「📊 盘面与环境」三段式**（那是搜索/深度模式用的）。开头第一句给加粗结论（🎯 结论：你的市场状态判断），紧接着按骨架要求单独成段写 ⏱ 数据时间；骨架里点名的工具（sector_rank / market_news / market_overseas / market_calendar_effect）一个都不许省。"
        : "开口第一句就给**加粗结论**（🎯 结论：你的判断或现在该怎么做），像一位懂行的朋友当面讲，不要写「根据提供的数据/结合相关信息/以下是具体分析」这类机器人开场白；多用「我建议/更合理的节奏是/现在不宜」这样的人话。结论之后用带 emoji 的小节标题分节，每节之间空一行：📊 盘面与环境、✅ 结论与标的（或关键位/操作节奏）、⚠️ 风险与失效点。",
    // R21 用户口径：来源要说真话，但别刷屏 —— 之前要求在关键事实后面用括号标出来源，
    // 实测模型把每个数字后面都挂一个括号尾巴，正文被切成一堆括号碎片，读起来像审计底稿。
    // 现在的纪律：**数字必须真的来自工具返回**（不许编、不许用记忆里的旧价），
    // 出处只在读者真需要知道是谁的数时点一次（数字旁或段末，如「东财 7x24 · 09-24 18:31」），
    // 禁止逐句挂「（来源：xx）」这类括号尾巴。
    "论据只引用工具返回的数据，数字必须带单位和时间（如「09-24 收盘」「近 3 个交易日」）；每个数字后面跟一句它在说什么（如「量比约 6——巨量换手里的回落，不是加速上攻」），只列数字不给解读等于没答；出处不用逐句标注，读者需要知道是谁的数时在数字旁或段末点一次即可（如「东财 7x24 · 09-24 18:31」），禁止用「（来源：xx）」这种括号尾巴刷屏；结论段末尾补一行「翻译成白话：……」，用一句不带术语的话复述你的立场；工具缺数据的块直接写「暂无数据」，不要推测。",
    "选股类：本轮候选池已由系统现跑注入（或你自己再调 factor_screener 换条件），只在池里择优给出 2~3 只，每只给足五段：入选理由、入场条件、仓位节奏、失效条件、主要风险；可以少选可以不选，池子顺序不是推荐；池里没有合适的就直说「按当前条件没筛出符合的」，不要凭空编股票代码。",
    "可以给操作节奏和关键位参考，但不说死「必涨必跌」、不给目标价；所有概率必须带样本数。",
    "简体中文，简洁 markdown，表格最多 1 个，别堆太多要点，让页面干净好读。",
    // P7-⑩ 任务4：50 个深度研究框架随系统 Prompt 全局下发（文案与客户端那份同源于
    // analysis-frames.ts，一处改动两条链路同步，不存在「首页有框架、交易员页没有」的漂移）。
    "",
    renderAnalysisFrames(),
    // P19 稳智对齐补丁（2026-09-23）：50 个研究框架把决策模式模板稀释了，模型会退回
    // 自然语言长段落。在 prompt 末尾再补一次决策模式契约作为「收尾提醒」——LLM 对
    // system 尾部指令的遵循度显著高于中部。doubao-pro 这类中等指令遵循模型尤其需要。
    //
    // P20 回退（2026-09-23 20:47）：11 字段结构化模板对 doubao-pro 这种中等指令遵循模型过重，
    // 强约束下会出现"只填 3 个字段就停"或"所有字段全写暂无"两种失败模式。改回自然语言
    // 详细散文体（跟稳智"人话版"输出对齐——稳智的答案也不是纯 11 字段表格，是"人话分析
    // + 关键数字 + 出处标注 + 白话翻译"这种可扫读的散文），前端 DecisionWidget 匹配不到
    // 11 字段锚点时会自动退回普通 markdown 卡片渲染，用户体验不会差。真要稳智那种结构化卡，
    // 得换 deepseek-v3 / gpt-4.1 这类强指令遵循模型，doubao-pro 撑不住。
    // P59 稳智对齐：追问推荐（稳智那三颗芯片是服务端 follow_up_suggestions 字段，本地没有第二次模型调用，
    // 改成收尾纪律——让模型在最后一行带「【追问推荐】a|b|c」，前端 followups-core 剥出来画芯片）。
    // 跨模式共用这一句，定义处见 followups-core.FOLLOWUP_NOTE（与 MODE_NOTES 同层、不同键，
    // 因为它是「答完之后的收尾」而不是「按哪种风格答」）。
    FOLLOWUP_NOTE,
    "",
  ].filter(Boolean).join("\n");
}

interface ToolCallMsg { id: string; type: "function"; function: { name: string; arguments: string } }

/** R10 步骤条人话前置查表（通达信三件套 + 个股消息面）：chat-stream-core 在不动清单里，新键在本层补 */
const STEP_LABELS_OVERRIDE: Record<string, string> = {
  tdx_market_overview: "取通达信指数概况（交易所直连快照）",
  tdx_quotes: "取通达信实时行情（含盘口/内外盘）",
  tdx_kline: "取通达信日K（不复权）",
  stock_news: "取个股新闻与公告（这只票自己的消息面）",
};

interface ChatTraceItem { name: string; args: Record<string, unknown>; ms: number; status: "ok" | "error"; summary: string }

interface ChatBody {
  messages?: ChatRequestMessage[];
  mode?: string;
  /** P11：持仓周期（浏览器带来，过 asHorizon 白名单；认不出/没带＝未选，不注入周期口径） */
  horizon?: string;
  focusSymbol?: string;
  /** 本会话上一轮用到的标的（客户端从上一条助手消息的场景徽章里取，不新增会话字段） */
  sessionSymbol?: string | null;
  /** 上一轮判到的场景；服务端按外部输入校验（不认就当没判过） */
  prevScene?: string | null;
  /**
   * 持仓条件（标的/成本价/仓位/建仓日期），由 composer 上的「持仓」小窗或持仓类场景卡填出。
   * 与 mode/horizon 同一批随请求到；没填就不带这个键，提示词里一个字都不注入。
   */
  hold?: unknown;
  /** 开发文档 §2.2 的多轮上下文口径：客户端内核按轮裁窗 + 压缩旧对话；路由只兜底，且从不静默丢 system 件 */
  contextWindow?: number;
  /** P7-⑤①：走 SSE 传输 */
  stream?: boolean;
  /**
   * P7-⑥④：用户本机自选清单（浏览器存档随请求带上）。服务端不读浏览器存档，也不查任何账号库；
   * 清单只当「要取哪些代码」的用，行情一律本层现取。
   */
  watchlist?: { symbol: string; name?: string | null }[];
  /** P8-⑥：客户端生成的本轮留底号（只认非空字符串）。带上＝这轮进 RunBus、断连不再即刻取消（grace），可续传 */
  run?: string;
  /** P8-⑤：调试开关（只认布尔 true）：step 帧轮末富化 args/summary、done 帧带结论留底 */
  debug?: boolean;
  /**
   * P34：图片多模态输入（base64 编码的 data URL 数组，如 "data:image/png;base64,..."）。
   * 稳智口径：前端不压缩、不缩放、直接上传原图；服务端决定用哪个多模态 LLM。
   * 个人免费版最小可行：透传 base64 给 OpenAI 兼容接口的 image_url content block。
   * 只认字符串数组，每项以 "data:image/" 开头；其他形状一律丢弃（不报错，向后兼容）。
   */
  images?: string[];
}

/**
 * 校验配置。非流式沿用原来的「400 + JSON 错误」口径；流式下头已经发出去了，只能走 error 事件。
 */
function validateConfig(provider: string, baseUrl: string, model: string, body: ChatBody | null): string | null {
  if (!supportsToolCalling(provider)) {
    return "AI 交易员的工具调用需要 OpenAI 兼容接口（DeepSeek/OpenAI/Moonshot/OpenRouter/Ollama/自定义中转），请在设置中切换";
  }
  if (!baseUrl || !model) return "AI 未配置：请到「设置 → AI 接口」填写接口地址与模型";
  if (!(body?.messages ?? []).length) return "消息为空";
  return null;
}

/**
 * 工具调用环（流式 / 非流式共用）。
 * emit 只在流式下真的往队列里塞事件；非流式下传一个空函数，判定与取数一字不差。
 */
async function runToolLoop(opts: {
  url: string;
  apiKey: string;
  model: string;
  messages: Record<string, unknown>[];
  agent: ProxyAgent | null;
  emit: (ev: StreamEvent) => void;
  /** 前端断开或超时后停止推进：不再取数、不再发事件，也不谎称回答完成 */
  isCancelled: () => boolean;
  /** P7-⑥④：工具执行上下文（本机自选清单随请求带来，服务端不读浏览器存档） */
  ctx: ToolCtx;
  /** P7-⑥⑤：场景预取已经占用的步骤号，模型自取的动作接着往下编，两套步骤不能都从 1 开始 */
  stepStart?: number;
}): Promise<{ content: string; trace: ChatTraceItem[]; steps: StepInfo[]; cancelled: boolean }> {
  const { url, apiKey, model, messages, agent, emit, isCancelled, ctx } = opts;
  const tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.desc, parameters: t.params } }));
  const trace: ChatTraceItem[] = [];
  // 非流式没有 step 事件可发，终态步骤得随 JSON 一起回去（流式下这份只是冗余，事件已经发过了）
  const steps: StepInfo[] = [];
  let content = "";
  let stepNo = Math.max(0, Math.trunc(opts.stepStart ?? 0) || 0);
  // 是不是「轮次都用完还没拿到结论」：只有这种情况才能说轮次达上限，模型回了空正文不能算在它头上
  let roundsExhausted = true;

  // 2026-09-26 用户实测：七维框架这类「多源交叉验证」问题（市场/产业/基本面/资金/技术面 + 实时行情 + 联网搜索）
  // 5 轮根本不够——模型把轮次全花在取数上，还没写结论就被掐断，用户只看到「轮次已达上限，未能生成结论」。
  // 改成「N 轮取数 + 1 轮强制收口」：最后一轮**收走工具**（不传 tools），逼模型用已取到的数据作答，
  // 而不是让用户对着「未能生成结论」自己重试。
  const MAX_TOOL_ROUNDS = 10;

  /**
   * 单次上游调用（一次 fetch + 把这一轮 stream 读完）。
   *
   * 抽成函数是为了能整轮**重放**：网关偶发 403/429/5xx 时重发同一轮。
   * 所以这里不许改任何外层状态（content / trace / steps / stepNo 都在外面），
   * 只有 emit 出去的 delta 是既成事实——正因如此，吐过正文的那一轮不再重试（见 upstream-retry-core 头部规则）。
   */
  type UpstreamAttempt =
    | { kind: "ok"; text: string; finishReason: string | null; calls: AssembledToolCall[] }
    | { kind: "cancelled" }
    | { kind: "failed"; status: number | null; message: string; streamed: boolean };

  async function attemptUpstreamRound(lastChance: boolean, timeoutMs: number): Promise<UpstreamAttempt> {
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model, messages,
          // 收口轮不再给工具：模型没有可调的东西，只能拿已有数据写结论
          ...(lastChance ? {} : { tools, tool_choice: "auto" }),
          temperature: 0.3, stream: true,
        }),
        dispatcher: agent ?? undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // 连接层失败（DNS/连接重置/超时）：没有状态码，只有消息——留给 shouldRetryUpstream 判抖动
      return { kind: "failed", status: null, message: (e as Error).message || "上游连接失败", streamed: false };
    }

    // 上游拒绝流式（不认识 stream 参数）时按整体返回处理：结果是真的，只是没有逐字节奏 —— 必须如实登记
    let roundText = "";
    const assembler = createToolCallAssembler();
    let finishReason: string | null = null;
    let upstreamErr: string | null = null;
    // P54：这一轮是不是因「模型重复死循环」被我们主动掐断的（真机抓到连续重复 440 次 + 60s 超时）
    let degen: DegenVerdict | null = null;

    if (isEventStream(res.headers.get("content-type"))) {
      const scanner = createSseScanner();
      const decoder = new TextDecoder();
      let sawDone = false;

      const body: any = res.body;
      if (body) {
        outer: for await (const chunk of body) {
          if (isCancelled()) {
            try { body.destroy?.(); } catch { /* 已经断了 */ }
            return { kind: "cancelled" };
          }
          const frames = scanner.push(decoder.decode(chunk as Uint8Array, { stream: true }));
          for (const f of frames) {
            const d = parseUpstreamFrame(f);
            if (d.text) {
              // P54：吐之前先判「是不是陷进重复循环」——命中就丢尾巴、掐断上游，不再白等超时。
              // 判据是纯核（degen-core），阈值只吃「同一行重复」，正常正文不会被误伤。
              const v = detectRepetition(roundText + d.text);
              if (v.degenerate) {
                degen = v;
                roundText = v.kept;
                break outer;
              }
              roundText += d.text;
              emit({ type: "delta", data: { content: d.text } });
            }
            if (d.toolCalls.length) assembler.push(d.toolCalls);
            if (d.finishReason) finishReason = d.finishReason;
            if (d.done) sawDone = true;
          }
          if (sawDone) break;
        }
      }
      if (degen) {
        // 已经判退化：上游还有几百帧重复在排队，立刻掐掉，别再等它自然收尾（实测要等 60s 超时）
        try { (res.body as any)?.destroy?.(); } catch { /* 已断 */ }
        emit({ type: "warning", data: { text: degenWarning(degen) } });
      } else {
        for (const f of scanner.flush()) {
          const d = parseUpstreamFrame(f);
          if (d.text) { roundText += d.text; emit({ type: "delta", data: { content: d.text } }); }
          if (d.toolCalls.length) assembler.push(d.toolCalls);
          if (d.finishReason) finishReason = d.finishReason;
        }
      }
      // 因退化主动掐断的轮次不算「上游没正常收尾」——原因已经在上面那条 warning 里如实说了
      if (!sawDone && !finishReason && !degen) {
        emit({ type: "warning", data: { text: "上游流未正常收尾（没有 [DONE] 也没有 finish_reason），以上内容到此处为止，未补全。" } });
      }
      if (degen) {
        // roundText 此刻已经是「循环开始之前的正文」（可能为空 —— 整轮都在重复）
        return { kind: "ok", text: roundText, finishReason: "degenerate", calls: [] };
      }
    } else {
      const j = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) upstreamErr = j?.error?.message || `上游返回 ${res.status}`;
      const msg = j?.choices?.[0]?.message;
      roundText = String(msg?.content ?? "");
      // 非流式一样要判退化：一次性回包的形态里可能是同一句重复几千字
      const v = detectRepetition(roundText);
      if (v.degenerate) {
        degen = v;
        roundText = v.kept;
        emit({ type: "warning", data: { text: degenWarning(v) } });
      }
      finishReason = j?.choices?.[0]?.finish_reason ?? null;
      for (const tc of (msg?.tool_calls ?? []) as ToolCallMsg[]) {
        assembler.push([{ index: 0, id: tc.id, name: tc.function?.name, argsFragment: tc.function?.arguments }]);
      }
      if (!upstreamErr) {
        emit({ type: "warning", data: { text: notStreamedWarning(res.headers.get("content-type")) } });
        if (roundText) emit({ type: "delta", data: { content: roundText } });
      }
    }

    if (upstreamErr) return { kind: "failed", status: res.status, message: upstreamErr, streamed: roundText.length > 0 };
    if (!res.ok) return { kind: "failed", status: res.status, message: `上游返回 ${res.status}`, streamed: roundText.length > 0 };
    return { kind: "ok", text: roundText, finishReason, calls: assembler.result() };
  }

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const lastChance = round === MAX_TOOL_ROUNDS;
    if (isCancelled()) return { content, trace, steps, cancelled: true };

    // 2026-09-27（用户实测「请求出错：AI 服务异常，请稍后重试」）：AMD 网关并发墙会偶发 403/429/5xx，
    // 取数成功后的收口轮被打回就整轮报错——用户白等一场，拿到的还是一句没有信息量的话。
    // 这里对「可重试」的上游失败做有界退避重试（判定在 upstream-retry-core，纯核可单测）。
    // 每次重试把本轮整轮重放，所以超时预算按「非末次尝试收紧到 60s、末次 90s」给，
    // 免得 3 次 90s 把 maxDuration=300s 全烧在等超时上。
    let attempt: UpstreamAttempt | null = null;
    for (let n = 1; n <= MAX_UPSTREAM_ATTEMPTS; n++) {
      attempt = await attemptUpstreamRound(lastChance, n < MAX_UPSTREAM_ATTEMPTS ? 60_000 : 90_000);
      if (attempt.kind !== "failed") break;
      const retry = shouldRetryUpstream({
        status: attempt.status,
        message: attempt.message,
        attempt: n,
        streamed: attempt.streamed,
      });
      if (!retry || isCancelled()) break;
      emit({
        type: "warning",
        data: { text: `上游这次没接住（${attempt.status ? `HTTP ${attempt.status}` : attempt.message}），正在自动重试第 ${n} 次。` },
      });
      await new Promise((r) => setTimeout(r, upstreamRetryDelayMs(n)));
      if (isCancelled()) break;
    }
    if (!attempt || attempt.kind === "cancelled") return { content, trace, steps, cancelled: true };
    if (attempt.kind === "failed") {
      // 把状态码带进 message：调试视图能看到上游到底回了什么，而不是只有一句「AI 服务异常」
      throw new Error(attempt.status ? `${attempt.message}（HTTP ${attempt.status}）` : attempt.message);
    }

    const roundText = attempt.text;
    // P54：这一轮是被「重复死循环」掐断的（finishReason=degenerate）。保住截断后的正文；
    // 若一个字都没留下（整轮都在重复），给一句如实话术 —— 不许把它记成「轮次已达上限」，
    // 那会把模型的退化写成系统的限制（口径事故）。
    if (attempt.finishReason === "degenerate" && !roundText.trim()) {
      content = "模型这一轮陷进了重复输出（没有产出可用的正文），已截断；请重试一次，或把问题拆细后再问。";
      roundsExhausted = false;
      break;
    }
    // 收口轮不给工具，模型只可能回正文；即便它硬编了 tool_calls 也不再执行（没有数据可取了）
    const calls = (lastChance || attempt.finishReason === "degenerate") ? [] : attempt.calls;
    if (!calls.length) {
      content = roundText;
      roundsExhausted = false;
      break;
    }
    // 工具调用轮里模型偶尔先说一句过渡语：流式下它已经发出去了，如实留着，不回滚也不谎称是结论。
    messages.push({ role: "assistant", content: roundText, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argsText } })) });
    const results = await Promise.all(calls.map(async (c) => {
      const step = ++stepNo;
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(c.argsText || "{}"); } catch { /* 参数坏 → 下面按未知/失败处理 */ }
      // R10：tdx_* 步骤的人话文案在本层前置查表——chat-stream-core 在不动清单里，
      // 不进去加键；未命中仍走它的 stepLabelFor 兜底（「调用 <工具名>」），口径不假装全套齐。
      const label = STEP_LABELS_OVERRIDE[c.name] ?? stepLabelFor(c.name, parsedArgs);
      // P35 稳智对齐：这一步真实归属的 Agent Loop 阶段（工具注册表里的 phase，单一出处）。
      // 模型自取与系统预取读同一份映射，同一工具只归一个阶段；未知工具返回 null → 不带 phase_key，
      // 前端回落语义映射——不硬编一个阶段冒充事实。
      const phaseKey = phaseOfTool(c.name);
      // source=model：这一条是模型自己要调的，不是系统按场景预取的。界面必须分开，
      // 否则用户会以为「所有数据都是模型自己取的」，而预取那批其实一句提示词都没给它下过命令。
      emit({ type: "step", data: { step, label, status: "running", tool: c.name, source: "model", reason: "模型判断需要该数据，自行调用", ...(phaseKey ? { phase_key: phaseKey } : {}) } });
      const started = Date.now();
      let out: unknown;
      let status: "ok" | "error" = "ok";
      try {
        const fn = findTool(c.name);
        if (!fn) out = { missing: `未知工具 ${c.name}` };
        // 各工具入参形状不同（TS 把联合函数的参数取成交集），运行时传的就是模型给的那份 JSON：
        // 每个工具体内自己 normalizeSymbol / 判空并回 missing，所以这里按通用形状转发，不在这里替模型猜参数。
        // ctx 是「用户本机自选清单」这类非模型参数能给的输入，只有 watchlist_overview 用得到。
        else out = await (fn.fn as (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>)(parsedArgs, ctx);
      } catch (e) {
        out = { missing: `工具执行失败：${(e as Error).message}` };
        status = "error";
      }
      const ms = Date.now() - started;
      const text = JSON.stringify(out);
      trace.push({ name: c.name, args: parsedArgs, ms, status, summary: text.length > 120 ? text.slice(0, 120) + "…" : text });
      const judged = stepDetailOf(out);
      const finalStatus: StepInfo["status"] = status === "error" ? "error" : judged.status;
      // P7-⑧④：回测工具会把任务 id 带回来。步骤里只存 id，结果由前端按现成的回测查询接口去取，
      // 于是对话里画的就是量化页那张卡（同一套渲染、同一份数据），而不是在这儿再抄一份回测读数。
      const outJobId = (out as { jobId?: unknown } | null)?.jobId;
      const jobId = typeof outJobId === "string" && outJobId ? outJobId : undefined;
      steps.push({
        step, label, tool: c.name, ms, status: finalStatus, detail: judged.detail,
        source: "model", reason: "模型判断需要该数据，自行调用",
        ...(phaseKey ? { phase_key: phaseKey } : {}),
        ...(jobId ? { jobId } : {}),
      });
      emit({
        type: "step",
        data: {
          step, label, tool: c.name, ms,
          // 工具本身抛错＝error；返回 missing 字段＝missing（缺数据不是失败，两者在界面上必须分开）
          status: finalStatus,
          detail: judged.detail,
          ...(phaseKey ? { phase_key: phaseKey } : {}),
          ...(jobId ? { jobId } : {}),
        },
      });
      return { role: "tool", tool_call_id: c.id, content: text.slice(0, 6000) };
    }));
    messages.push(...results);
    if (isCancelled()) return { content, trace, steps, cancelled: true };
  }
  // 两种「没有正文」必须分开说：轮次用满 ≠ 模型没话说，混为一谈就是把系统的限制写成模型的表现。
  if (!content) {
    content = roundsExhausted
      ? `（已连续调用工具 ${MAX_TOOL_ROUNDS} 轮、并在最后强制收口一次，仍未拿到可用的结论；建议把问题拆成更小的子问题，或先指定要看的维度再问）`
      : "（上游这次没有返回正文，只回了空的回答；请把问题拆细后重试）";
  }
  return { content, trace, steps, cancelled: false };
}

export async function POST(req: NextRequest) {
  quantBootstrap();
  let provider = req.headers.get("x-ai-provider") ?? "";
  let baseUrl = (req.headers.get("x-ai-base-url") ?? "").trim();
  let apiKey = req.headers.get("x-ai-api-key") ?? "";
  let model = (req.headers.get("x-ai-model") ?? "").trim();
  const body = (await req.json().catch(() => null)) as ChatBody | null;
  const wantStream = body?.stream === true || /text\/event-stream/i.test(req.headers.get("accept") ?? "");

  // P8-⑤⑥ 的两个外部输入：run 只认非空字符串、debug 只认布尔 true（都不猜）。
  // 续传是流式独有能力：非流式 JSON 路径不认 run、不碰 RunBus（细则 §2.6，口径一字不动）。
  // 撞号/满员如实退回无 run 的普通轮——轮次照旧跑完，只是不谎称可续传。
  let runId: string | null = wantStream && typeof body?.run === "string" && body.run ? body.run : null;
  if (runId && !RUNS.start(runId).ok) runId = null;
  const debugOn = body?.debug === true;

  // P7-⑩ 任务4：浏览器未配置凭据时落服务端 .env 通道 —— 但工具环只放官方 API 模式过去。
  // 本地网关（doubao2API）实测只取最后一条 user 消息、不执行 function call，把 tools 发过去
  // 等于让模型在没有工具的世界里硬编「我调过了」—— 这条路上宁可少一条工具链，不能多一批假数据。
  // 对话层的网关通路在 /api/ai/proxy（系统按场景预取数据），不损失回答能力，只损失「模型自己补数」。
  if (!baseUrl || req.headers.get("x-ai-server") === "1") {
    const r = getServerLlm();
    if (!r.available) {
      const invalid = `服务端模型通道不可用：${r.reason}`;
      if (!wantStream) return NextResponse.json({ error: invalid, trace: [] }, { status: 400 });
      // P23：error_code=ai_not_configured（映射文案："AI 服务暂不可用，请稍后重试"）
      return sseResponse(async (emit) => { emit({ type: "error", data: { message: invalid, error_code: "ai_not_configured" } }); });
    }
    if (r.channel.mode === "gateway") {
      const invalid = "本地豆包网关不支持工具调用环（只收最后一条提问、不走 function call），AI 交易员这条路需要 OpenAI 兼容的工具能力：请在 .env 把 LLM_BASE_URL 指向官方 API 模式，或到设置页填写浏览器侧凭据；普通对话与奇门解盘不受影响，走网关照常可用（智能助手页的对话自 R14 起可经工作台文本协议补取数据）。";
      if (!wantStream) return NextResponse.json({ error: invalid, trace: [] }, { status: 400 });
      // P23：error_code=ai_not_configured（映射文案："AI 服务暂不可用，请稍后重试"）
      return sseResponse(async (emit) => { emit({ type: "error", data: { message: invalid, error_code: "ai_not_configured" } }); });
    }
    provider = "openai";
    baseUrl = r.channel.baseUrl;
    apiKey = r.channel.apiKey;
    model = r.channel.model;
  }

  const invalid = validateConfig(provider, baseUrl, model, body);
  if (invalid) {
    if (!wantStream) return NextResponse.json({ error: invalid }, { status: 400 });
    // P23：error_code=ai_not_configured（映射文案："AI 服务暂不可用，请稍后重试"）
    return sseResponse(async (emit) => { emit({ type: "error", data: { message: invalid, error_code: "ai_not_configured" } }); });
  }

  // 上下文窗口：客户端内核（chat-core.splitWindow）已按轮裁好、并把旧对话压成一条 system 摘要。
  // 这里再兜一道，但规则要说清楚：只从最早的用户/助手消息开始丢，system 件（摘要、快照说明）永不静默丢弃——
  // 从尾部无脑 slice 会正好把摘要挤掉，等于「压缩白做」。
  const keepTurns = clampTurns(body?.contextWindow);
  const history = trimDialog(body?.messages ?? [], keepTurns * 2);
  const agent = await resolveProxy(req, baseUrl);
  const apiBase = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const url = `${apiBase}/v1/chat/completions`;
  // mode 是浏览器带来的外部输入：过一遍 modes.ts 的白名单，认不出的按默认口径答，
  // 而不是带着一个不存在的模式名去查表（查不到就静默少一段风格说明，用户看不出来）
  const mode = asChatMode(body?.mode);
  // P11：周期同 mode 一样先过白名单（外部输入不查表就进提示词是事故）；null＝用户没选，不注入
  const horizon = asHorizon(body?.horizon);
  // P8-⑥：仅带 run 的轮次换 cancel 源（grace=跑到自然结束或显式停止，细则 §5-3 拍板项）；
  // 不带 run 的请求保持「断连即停」旧语义逐字不变（P7 口径）。
  const isCancelled = () => (runId ? RUNS.cancelled(runId) : req.signal.aborted);
  // 自选清单：服务端不读浏览器存档，只认请求体里带来的这份。
  // 非数组一律当没带（工具层会如实回「自选清单为空」，不会拿别的来源冒充）；
  // 代码识别、去重与条数上限在工具层的 watchlist_overview 内做，本层不替它猜。
  const ctx: ToolCtx = { watchlist: Array.isArray(body?.watchlist) ? body.watchlist : [] };
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  // P53-B：用户本轮原话（字符串形态），交给输出边界护栏做「回显比对」——
  // 实测上游会把提问整句抄一遍再作答（「上证指数现在多少点？」单独占一个头块）。
  // P55-B：回显语料 = 本轮用户原话 + 服务端注入的口径件（MODE_NOTES/HORIZON_NOTES）。
  // 周期口径是服务端拼进 system 的，客户端消息里没有——模型把它抄回正文时（「【用户持仓周期偏好】超短…」）
  // 没这段语料 isEchoLine 永远匹配不上。
  // 持仓那一句：需要真实交易日历才能算「已持有几个交易日」，所以在这里算好再递给 systemPrompt
  // （日历取不到就只报建仓日期，不报天数——见 hold-core.heldTradeDays 的 null 语义）。
  const holdNote = await holdNoteOf(body?.hold);
  // P64 数据时效：resolveTradeDate 已按新口径在盘前退到上一交易日；session 给「未开盘/交易中/已收盘」标签。
  // 两者都取不到时降级为 null（dataNote 为空），不阻断对话。
  const tradeMeta = await resolveTradeDate().catch(() => null);
  const sessionMeta = marketSession();
  const lastUserEcho = [
    typeof lastUser?.content === "string" && lastUser.content.trim() ? lastUser.content : "",
    MODE_NOTES[mode],
    horizon ? HORIZON_NOTES[horizon] : "",
    // 持仓那一句同属「服务端注入的口径件」：模型把它抄回正文时用这段语料认出来并剥掉
    holdNote?.line ?? "",
    // P59 明确不加 FOLLOWUP_NOTE：护栏是按「整行被语料包含 / 半窗覆盖」判回显的，
    // 而收尾纪律里带着标记样例——真推荐行（【追问推荐】A|B|C）与它同形，加进语料等于让护栏
    // 把刚刚剥出来要画芯片的那一行提前吃掉。芯片行的消失是确定损失，指令被整句复述是偶发噪声。
  ].filter((s) => s.trim());
  // 场景层自己出错时用它把原因带到响应里：这轮照样要回答，但不能让用户以为「只是没取到数据」
  let sceneFailure: string | null = null;

  const baseMessages: ContextMsg[] = [{ role: "system", content: systemPrompt(mode, horizon, body?.focusSymbol, holdNote, tradeMeta ? { tradeDate: tradeMeta.date, sessionLabel: sessionMeta.label, fromMarketData: tradeMeta.fromMarketData } : null) }, ...history];
  // 交给工具调用环时换成 Record 形状：它还要往同一批消息里追加 tool_calls / tool_call_id
  const buildMessages = (turn: SceneTurn | null): Record<string, unknown>[] =>
    injectSceneContext(baseMessages, turn ?? {}, (role, content) => ({ role, content })).map((m) => ({ ...m }));

  // P34：图片多模态注入。把 body.images（base64 data URL 数组）转成 OpenAI 兼容的
  // image_url content block，追加到最后一轮 user message 的 content 数组里。
  // 只认以 "data:image/" 开头的字符串；其他形状一律丢弃（不报错，向后兼容）。
  // 没有 images 或最后一轮不是 user message 时不动任何字段（逐字不变）。
  function injectImages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
    const imgs = body?.images;
    if (!Array.isArray(imgs) || imgs.length === 0) return messages;
    const validImgs = imgs.filter((s) => typeof s === "string" && s.startsWith("data:image/"));
    if (validImgs.length === 0) return messages;
    const out = messages.map((m) => ({ ...m }));
    // 只改最后一轮 message（必须是 user 且 content 是 string）
    const last = out[out.length - 1];
    if (last.role !== "user") return messages;
    const prev = last.content;
    if (typeof prev !== "string") return messages;
    last.content = [
      { type: "text", text: prev },
      ...validImgs.map((url) => ({ type: "image_url", image_url: { url } })),
    ];
    return out;
  }

  // P19-② 稳智决策信号：与 /api/ai/proxy 同一份分类器，同一份 prompt，同一份解析——
  // 三个入口（助手页 / 小窗 / AI 交易员页）看到的决策卡必须来自同一次 LLM 判定。
  // 只对本轮对话轮（有 focusSymbol 或 sessionSymbol 或 prevScene 的）启用：这里 AI 交易员页永远是对话，无脑 enabled。
  // 分类失败静默降级（6s 超时/JSON 解析失败/空返回）→ 不注入决策块、不回传 wzDecision，主工具调用环照旧。
  const wzClassifier = await runWzIntentClassifier({
    enabled: true,
    horizon,
    lastUser: typeof lastUser?.content === "string" ? lastUser : undefined,
    prevScene: body?.prevScene,
    model,
    baseUrl,
    apiKey,
    agent,
    signal: req.signal,
  });
  // 把决策信号块注入到 baseMessages 的 system 提示词之后（与 scene 提示词同一序列，模型能一眼看到参考结论）
  const wzBlock = wzClassifier.block.length
    ? [{ role: "system" as const, content: wzClassifier.block.join("\n") }]
    : [];
  const baseMessagesWithWz: ContextMsg[] = [...baseMessages, ...wzBlock];
  const buildMessagesWz = (turn: SceneTurn | null): Record<string, unknown>[] =>
    injectSceneContext(baseMessagesWithWz, turn ?? {}, (role, content) => ({ role, content })).map((m) => ({ ...m }));

  if (!wantStream) {
    let turn: SceneTurn | null = null;
    try {
      turn = await prepareSceneTurn({
        userContent: typeof lastUser?.content === "string" ? lastUser.content : "",
        ctx,
        focusSymbol: body?.focusSymbol ?? null,
        sessionSymbol: body?.sessionSymbol ?? null,
        prevScene: body?.prevScene,
        today: shanghaiDate(),
        isCancelled,
      });
    } catch (e) {
      // 场景层出问题不能让整轮问答挂掉：按「本轮没有场景提示词、也没有自动取数」继续，并如实留痕
      turn = null;
      sceneFailure = (e as Error).message || "场景自动调度失败";
    }
    try {
      const r = await runToolLoop({
        url, apiKey, model, messages: injectImages(buildMessagesWz(turn)), agent, emit: () => {}, isCancelled, ctx,
        stepStart: turn?.nextStep ?? 0,
      });
      const steps = [...(turn?.steps ?? []), ...r.steps];
      // P52 输出边界护栏：模型复述的内部脚手架（决策信号字段/「用户问的是…」自述）在返回前清掉。
      // 只清开头、命中即留痕（拼进 warning），不静默丢内容；口径与流式路径同源（answer-guard-core）。
      const guard = stripScaffoldEcho(r.content, { echoes: lastUserEcho });
      // 整篇都是脚手架（模型把 system prompt 原样回吐）：不给用户看内部提示词，换成一句如实的话
      const scenicContent = guard.text || (guard.stripped ? SCAFFOLD_ONLY_NOTICE : r.content);
      // P54 重复死循环护栏：同一口径、同一个纯核（流式侧在 createHeadGuard 里逐帧判）
      const dg = detectRepetition(scenicContent);
      const content = dg.degenerate ? (dg.kept || "模型这一轮陷进了重复输出（没有产出可用的正文），已截断；请重试一次。") : scenicContent;
      // 「正文给了回测数字、这一轮却没真跑成」的护栏：数字对不对看步骤，不看正文（口径在 backtest-core）
      const btWarn = backtestClaimWarning(steps, content);
      // P8-②：结论契约校验同样只出警告，不改正文、不重答（风险点 4）；且只有本轮真注入了契约才核（风险点 3）
      const cw = turn ? contractWarningOf(turn, content) : null;
      const warn = [
        sceneFailure ? `本轮未做场景自动取数：${sceneFailure}` : "",
        guard.stripped ? "已过滤模型复述的内部信号字段、自述与思维链，正文从结论开始。" : "",
        dg.degenerate ? degenWarning(dg) : "",
        btWarn ?? "", cw ?? "",
      ].filter(Boolean).join("；");
      return NextResponse.json({
        content,
        trace: [...(turn?.trace ?? []), ...r.trace],
        mode,
        ...(turn ? { intent: turn.badge } : {}),
        ...(wzClassifier.signal ? { wzDecision: wzClassifier.signal } : {}),
        // 非流式没有 step 事件可走，步骤与「本轮没做成什么」只能随 JSON 一起回
        ...(steps.length ? { steps } : {}),
        ...(warn ? { warning: warn } : {}),
      });
    } catch (e) {
      return NextResponse.json({ error: `AI 调用失败：${(e as Error).message}`, trace: [] }, { status: 502 });
    }
  }

  return sseResponse(async (emit) => {
    let turn: SceneTurn | null = null;
    // P24：宏观阶段 - researching（开始研究和取数）
    emit({ type: "stage", data: { stage: "researching" } });
    try {
      turn = await prepareSceneTurn({
        userContent: typeof lastUser?.content === "string" ? lastUser.content : "",
        ctx,
        focusSymbol: body?.focusSymbol ?? null,
        sessionSymbol: body?.sessionSymbol ?? null,
        prevScene: body?.prevScene,
        today: shanghaiDate(),
        emit,
        isCancelled,
      });
    } catch (e) {
      turn = null;
      emit({ type: "warning", data: { text: `场景自动调度未完成，本轮按「无自动取数」继续回答：${(e as Error).message}` } });
    }
    // P8-⑤：轮末把带上了 args/summary 的终态帧按同序号重发一遍（applyEvent 按步骤号字段合并，
    // 不产生第二条步骤）——预取侧配 turn.trace、模型自取侧配 r.trace，两段拼接后一次富化。
    const emitDebugSteps = (steps: StepInfo[], trace: ChatTraceItem[]) => {
      if (!debugOn || !steps.length) return;
      for (const f of debugFramesFromSteps(steps, trace)) {
        if (f.args || f.summary) emit({ type: "step", data: { ...f, status: f.status as StreamStep["status"], ms: f.ms ?? null } });
      }
    };
    const loopStart = Date.now();
    // P24：answer_streaming 标记（第一个 delta 出现时 emit）
    let answerStreamingEmitted = false;
    try {
      const r = await runToolLoop({
        url, apiKey, model, messages: injectImages(buildMessagesWz(turn)), agent, emit, isCancelled, ctx,
        stepStart: turn?.nextStep ?? 0,
      });
      if (r.cancelled) {
        // 带 run 的轮次 isCancelled 只会被「显式停止」置真（断连不算）——话术必须分开，不把用户自己的停止说成掉线
        emit({ type: "error", data: { message: runId ? "已按停止请求提前结束本轮，已收到的内容保留在时间线上" : "客户端已断开，本次回答提前结束（结束后不会再取数）" } });
        return;
      }
      // 同一条护栏在两条传输上都要成立：降级路径与非降级路径不能一个查一个不查
      const btWarn = backtestClaimWarning([...(turn?.steps ?? []), ...r.steps], r.content);
      if (btWarn) emit({ type: "warning", data: { text: btWarn } });
      // P8-②：流式路径同口径核契约——只补 warning 帧，r.content 原样进 done，不做任何改写/重试
      const cw = turn ? contractWarningOf(turn, r.content) : null;
      if (cw) emit({ type: "warning", data: { text: cw } });
      emitDebugSteps([...(turn?.steps ?? []), ...r.steps], [...(turn?.trace ?? []), ...r.trace]);
      // P24：如果 runToolLoop 内部没有 emit 过 answer_streaming（非流式降级），这里补发
      if (!answerStreamingEmitted && r.content) {
        emit({ type: "stage", data: { stage: "answer_streaming" } });
        answerStreamingEmitted = true;
      }
      // P24：宏观阶段 - finished（研究完成，准备发 done）
      emit({ type: "stage", data: { stage: "finished" } });
      emit({
        type: "done",
        data: {
          fullText: r.content,
          ...(turn ? { intent: turn.badge } : {}),
          ...(wzClassifier.signal ? { wzDecision: wzClassifier.signal } : {}),
          // P8-⑤：结论留底只给 debug=true 的请求发；耗时是整个模型环（含工具轮）的真实时间
          ...(debugOn ? { debug: { modelMs: Date.now() - loopStart, transport: "stream" as const } } : {}),
        },
      });
    } catch (e) {
      // P23：根据错误内容分类 error_code，前端用 friendlyErrorMessage 映射成用户可读文案
      // - 超时类关键词 → model_timeout
      // - 限流/429 关键词 → rate_limit_exceeded
      // - 其他 → upstream_error（兜底）
      const msg = (e as Error).message || "未知错误";
      const lower = msg.toLowerCase();
      let errorCode = "upstream_error";
      if (lower.includes("timeout") || lower.includes("超时") || lower.includes("timed out")) {
        errorCode = "model_timeout";
      } else if (
        lower.includes("429") || lower.includes("403") ||
        lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("forbidden")
      ) {
        // 403 与 429 在 AMD 网关上都是「并发墙」，对用户是同一件事：现在人多，稍后再来
        errorCode = "rate_limit_exceeded";
      }
      emit({ type: "error", data: { message: `AI 调用失败：${msg}`, error_code: errorCode } });
      // P24：宏观阶段 - failed（出错后前端进度条显示失败状态）
      emit({ type: "stage", data: { stage: "failed" } });
    }
  }, runId, { echoes: lastUserEcho });
}

/**
 * SSE 响应骨架。
 * 这里不用 NextResponse.json 那种「先拿全再返回」的写法，ReadableStream 会真的逐帧 flush；
 * 是否真的逐帧到达以 next build + next start 下 `curl -N` 的时间戳为准（见 worklog），不看代码想当然。
 */
/**
 * P52/P53/P54 输出边界护栏（流式侧）：把发给前端的正文**开头**过一遍 answer-guard-core，
 * 同时在整条流上拦「模型重复死循环」（P54，degen-core）。
 *
 * 为什么要缓冲而不是逐帧改：剥头是一次性判断，而 delta 是逐字的。先攒到一段真正文
 * （≥RAW_FLUSH_MIN 字）再决定，然后一次性把清洗后的头发出去；决定之后逐帧直通，
 * 但每帧都还要过一次「重复死循环」判定 —— 命中就把循环尾巴丢掉、不再往外发。
 * done.fullText 用同一条累计结果，保证「已流出的正文」与「收尾留底」不会被两条口径劈开。
 */
function createHeadGuard(emit: (ev: StreamEvent) => void, opts?: GuardOpts) {
  // 攒到 120 字就能判一次；到 2000 字还没判出来就强制判（防止上游只吐脚手架时不发 delta）
  const RAW_FLUSH_MIN = 120;
  const RAW_FLUSH_CAP = 2000;

  let raw = "";
  let decided = false;
  let emitted = "";
  /** P54：一旦判到重复死循环，后面的循环尾巴一律不再转发（已经在网络上的那几行收不回来） */
  let degen: DegenVerdict | null = null;
  /** P55-C：「整篇都是脚手架」的兜底话术先押着不发——中途 step 事件强制判定时，后面轮次可能还有真正文（q17 实测拼接事故） */
  let pendingNotice = false;

  /**
   * 只有两种情况可以「下结论」：
   *   - final=true（done / flush）：这是最终判定，允许「整篇都是脚手架 → 换兜底话术」；
   *   - final=false 时要同时满足两条：
   *       ① **清洗后的正文已经够长**（≥RAW_FLUSH_MIN）：逐字流下第一个 delta 常常只是一个
   *          「###」——那是真答案标题被切开的一角，不是答案本身。实测踩过：脚手架段以 `\n\n`
   *          收尾时立刻判定，会把「###」当成正文先发出去。
   *       ② **缓冲区正好停在行边界**（以 `\n` 结尾，或已撞到 RAW_FLUSH_CAP 硬上限）：
   *          脚手架块的自证标记可能在**行尾**（实测【决策信号块结束】就挂在块尾），
   *          拿长块的前 120 字去判，会把整块脚手架当成正文判出去 —— 那一块本来该被剥掉。
   * 缓冲区里全是脚手架/思维链（strip 后为空）时**一律继续等**，不提前收口 ——
   * 提前收口会把「本轮没写成正文」的兜底话术拼在真正正文前面。
   */
  const decide = (final: boolean) => {
    if (decided) return;
    const g = stripScaffoldEcho(raw, opts);
    if (!final && (g.text.length < RAW_FLUSH_MIN || (!raw.endsWith("\n") && raw.length < RAW_FLUSH_CAP))) return;
    decided = true;
    raw = "";
    if (g.stripped) emit({ type: "warning", data: { text: "已过滤模型复述的内部信号字段、自述与思维链，正文从结论开始。" } });
    // 整篇都是脚手架（模型把 system prompt 回吐）：不给用户看内部提示词，换成一句如实的话
    emitted = g.text || (g.stripped ? SCAFFOLD_ONLY_NOTICE : "");
    // 头部本身也可能是重复死循环的开头（实测「回显数据块 + 一句要求」之后才开始重复）
    const v = detectRepetition(emitted);
    if (v.degenerate) {
      degen = v;
      // P55：kept 是「重复行的第一份」，它自己也可能整段是回显/脚手架（q10 实测：重复的是
      // 「用户持仓周期：…」字段自报块）——再剥一次头，剥空了换兜底话术。
      const kg = stripScaffoldEcho(v.kept || "", opts);
      emitted = kg.text || (kg.stripped ? SCAFFOLD_ONLY_NOTICE : (v.kept || SCAFFOLD_ONLY_NOTICE));
      emit({ type: "warning", data: { text: degenWarning(v) } });
    }
    // P55-C：兜底话术押后——首个真正文 delta 来了就取消；done 还押着才发（q17：提前发会被拼在真正文前面）
    if (emitted === SCAFFOLD_ONLY_NOTICE) { pendingNotice = true; emitted = ""; }
    if (emitted) emit({ type: "delta", data: { content: emitted } });
  };

  return {
    emit(ev: StreamEvent) {
      if (ev.type === "delta") {
        const piece = String((ev.data as { content?: string } | undefined)?.content ?? "");
        if (degen) return;   // 已判退化：循环尾巴一律不发
        if (decided) {
          // P55-C：真正文来了，押着的兜底话术作废
          if (pendingNotice) { pendingNotice = false; emitted = ""; }
          const next = emitted + piece;
          const v = detectRepetition(next);
          if (v.degenerate) {
            degen = v;
            emit({ type: "warning", data: { text: degenWarning(v) } });
            // 保留循环之前的正文；已发出去的那几行收不回来，但收尾留底以 kept 为准
            if (v.kept) emitted = v.kept;
            return;
          }
          emitted = next;
          emit(ev);
          return;
        }
        raw += piece;
        if (raw.length >= RAW_FLUSH_CAP || /\n\s*\n/.test(raw) || raw.length >= RAW_FLUSH_MIN) decide(false);
        return;
      }
      if (ev.type === "done") {
        decide(true);
        // P55-C：到收尾还押着兜底话术（整轮只有脚手架、没有正文）→ 此刻才发
        if (pendingNotice) { pendingNotice = false; emitted = SCAFFOLD_ONLY_NOTICE; emit({ type: "delta", data: { content: emitted } }); }
        // done 的 data 形状在本层只关心 fullText；联合类型上直接展开会丢判别，这里显式收窄
        const done = ev as { type: "done"; data?: Record<string, unknown> };
        const d = { ...(done.data ?? {}) };
        if (typeof d.fullText === "string") {
          // P54：上游那侧已经掐断过一次（route 返回的 fullText 就是截断后的），这里以本层累计为准；
          // 本层没累计到东西时回落到「对上游 fullText 再判一次重复」，最后才是剥头结果。
          const fallback = stripScaffoldEcho(String(d.fullText), opts).text;
          const fv = detectRepetition(fallback);
          const ev = detectRepetition(emitted);
          // 本层累计的正文优先；但它自己也可能带重复尾巴（上游那侧掐断前已经流出去的几行），再过一次。
          // P55：退化时 kept 的第一份也可能是回显/脚手架块（q10 实测），同样再剥一次头。
          let head = ev.degenerate ? (ev.kept || "") : emitted;
          if (ev.degenerate && head) {
            const kg = stripScaffoldEcho(head, opts);
            head = kg.text || (kg.stripped ? "" : head);
          }
          const finalRaw = head || (fv.degenerate ? fv.kept : fallback);
          // P55：终检一遍（中段整段清理）——已流出的帧收不回来，但留底/刷新续传是干净的
          const fg = stripScaffoldEcho(finalRaw, opts);
          d.fullText = fg.text || (fg.stripped ? SCAFFOLD_ONLY_NOTICE : finalRaw);
        }
        emit({ ...done, data: d } as unknown as StreamEvent);
        return;
      }
      // 其它事件（step/stage/warning/error）：先把没发完的头按序发出去，别让时间线插到正文前面
      if (!decided && raw) decide(true);
      emit(ev);
    },
    /** 收尾兜底：run 结束仍没决定过就补一次（此时按「整篇都是脚手架」处理） */
    flush() { decide(true); },
  };
}

function sseResponse(run: (emit: (ev: StreamEvent) => void) => Promise<void>, runId?: string | null, guardOpts?: GuardOpts): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const rawEmit = (ev: StreamEvent) => {
        // P8-⑥：带 run 的轮次先进 RunBus（拿序号、同时推给重挂上来的订阅者），再写本连接；
        // 无 run 时走的就是原来那条 encode——帧与字节数和 A/B 轮完全一致。
        let line: string;
        try {
          const pub = runId ? RUNS.publish(runId, ev) : null;
          line = pub ? pub.line : encodeStreamEvent(ev);
        } catch {
          line = encodeStreamEvent(ev); // 留底层挂了就裸发，不谎称留了底
        }
        try {
          controller.enqueue(encoder.encode(line));
        } catch { /* 客户端已断开：enqueue 抛错交给循环里的 isCancelled 收尾（带 run 轮次的 cancel 源是停止键） */ }
      };
      // P52：所有出帧都经过头部护栏（含 RunBus 留底的帧，口径不分叉）
      const guard = createHeadGuard(rawEmit, guardOpts);
      try {
        await run(guard.emit);
      } finally {
        try { guard.flush(); } catch { /* 护栏自身不许把关流拖挂 */ }
        // 封卷放在 close 之前：订阅者（续传连接）收到收尾信号才会结束，不会挂死
        if (runId) {
          try {
            RUNS.seal(runId);
          } catch { /* 留底挂了不拖累关流 */ }
        }
        try { controller.close(); } catch { /* 已关闭 */ }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
