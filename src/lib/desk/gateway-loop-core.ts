// R14 网关文本协议工具环 —— 纯核（零 IO、零 import，node --test 直跑）。
//
// 为什么要这条环：doubao2API 网关实测只取最后一条 user 消息、不走 function call（R11/R12 侦查结论），
// 官方工具环在这条路上用不了。但模型「还缺哪份数据」是它自己最清楚的——于是约定一个纯文字协议：
// 模型在回答末尾按 [[KAIRO_FETCH]]{...}[[/KAIRO_FETCH]] 发取数请求，工作台解析后**真去调
// chat-tools 的同一批工具实现**（不开第二条数据管道），把带出身、带耗时的结果折回对话让它续答。
//
// 数据纪律一寸不松：
//  - 只有随结果块回来的数据才算真取到——「模型发了请求」≠「模型已经查到」；
//  - 每块结果自报工具/参数/状态（取到/没取到/失败/未开放）与耗时，进同一条步骤时间线；
//  - 请求不是合法 JSON、工具不在开放清单，都如实回「未执行」，不猜、不瞒、不编。
//
// 本模块只做字符串层面的协议解析与拼装；执行工具、发流是路由的事。

/** 请求块的开闭标记：整行成对出现，块内是一条 JSON。选带方括号的 ASCII 记号，正文里几乎不可能撞车。 */
export const FETCH_OPEN = "[[KAIRO_FETCH]]";
export const FETCH_CLOSE = "[[/KAIRO_FETCH]]";

/** 补数轮次上限：一条 user 里最多「请求→补→（再）请求→补→终答」两轮，防无底循环 */
export const MAX_FETCH_ROUNDS = 2;
/** 单轮最多执行的请求数：超出条数不执行，如实告知，防一句回十个块把网关拖死 */
export const MAX_REQUESTS_PER_ROUND = 4;
/** 不开放给网关文本环的工具：回测要白名单口径与 jobId 后续查询，那是 AI 交易员/量化门户的路 */
export const GATEWAY_LOOP_BLOCKED = ["run_backtest"];
/** 时间线步骤的 reason 原文：这轮是模型开口要的，系统代取执行——和「系统预取」必须分开 */
export const GATEWAY_LOOP_STEP_REASON = "模型经文本协议请求补取（网关工具环·工作台代取执行）";

export interface FetchRequest {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface ParsedFetch {
  /** 本轮是否出现过开标记（出现即按协议吞掉展示，不再外发） */
  markerFound: boolean;
  /** 标记块之前的正文（用户该看到的那部分） */
  preText: string;
  /** 解析成功的请求（按出现顺序，未做条数截断——截断是接线层的事） */
  requests: FetchRequest[];
  /** 解析失败的请求块原文（截 200 字）：JSON 坏了、缺工具名、开标记没闭 */
  malformed: string[];
}

/** 从请求块原文解析一条 JSON；不合法返回 null（调用方落 malformed，不抛错） */
function oneRequest(raw: string): FetchRequest | null {
  try {
    const o = JSON.parse(raw.trim()) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const rec = o as Record<string, unknown>;
    const tool = typeof rec.tool === "string" ? rec.tool.trim() : "";
    if (!tool) return null;
    const args = rec.args && typeof rec.args === "object" && !Array.isArray(rec.args)
      ? (rec.args as Record<string, unknown>)
      : {};
    const reason = typeof rec.reason === "string" ? rec.reason : "";
    return { tool, args, reason };
  } catch {
    return null;
  }
}

/** 把字面量转成可进 RegExp 的片段（标记全是方括号，转义不了一律拼歪） */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * 解析整段回答里的取数请求。形状约定：preText 是第一个开标记之前的文字；
 * 请求块之后的文字按协议不该出现（卡里写明「发完请求就收口」），真出现了也不回炉展示——
 * 宁可少一段没按规矩来的尾巴，也不把半截协议文本混进答案。
 */
export function parseFetchRequests(text: string): ParsedFetch {
  const src = text ?? "";
  const first = src.indexOf(FETCH_OPEN);
  if (first === -1) return { markerFound: false, preText: src, requests: [], malformed: [] };
  const preText = src.slice(0, first);
  const requests: FetchRequest[] = [];
  const malformed: string[] = [];
  const re = new RegExp(`${escapeRe(FETCH_OPEN)}([\\s\\S]*?)${escapeRe(FETCH_CLOSE)}`, "g");
  let lastClose = -1;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    lastClose = m.index + m[0].length;
    const req = oneRequest(m[1]);
    if (req) requests.push(req);
    else malformed.push(m[1].trim().slice(0, 200));
  }
  // 开了没闭（模型话说一半断流/忘了收尾）：整段尾巴按协议吞进标记区，记 malformed 不猜内容
  if (lastClose === -1) malformed.push(src.slice(first).slice(0, 200));
  else if (src.slice(lastClose).indexOf(FETCH_OPEN) !== -1) {
    // 极端：闭块之后又冒出一个开标记却没跟上闭标记——同样如实记，不当正文回显
    malformed.push(src.slice(lastClose).slice(0, 200));
  }
  return { markerFound: true, preText, requests, malformed };
}

/** 把请求块整段（含未闭合的尾巴）从文本里剥干净：终答外发前的最后一道防线，宁剥不误显示 */
export function stripFetchBlocks(text: string): string {
  const src = text ?? "";
  const first = src.indexOf(FETCH_OPEN);
  if (first === -1) return src;
  return src.slice(0, first).trimEnd();
}

/**
 * 流式拦截器：把「可能正在拼开标记」的尾部扣住不发，其余原样放行；
 * 一旦拼出完整开标记，本轮之后的文字全部扣住（只进日志解析，不再外发）。
 * 与 parseFetchRequests 各司其职：这个只管「用户不该看到协议块」，解析一律用整段原文。
 */
export interface FetchStreamFilter {
  /** 喂进一个流式分片，返回此刻可以外发的文字（可能为空串） */
  push(chunk: string): string;
  /** 流收尾：把一直没能拼成标记的扣住尾放出去（误触发的正常文字不能吞） */
  flush(): string;
  /** 本轮是否扣住过完整开标记 */
  swallowed(): boolean;
  /** 截至此刻已外发的文字总长：降级重发要判断「用户屏幕上有没有字」 */
  emittedLen(): number;
}

export function createFetchStreamFilter(): FetchStreamFilter {
  let held = "";
  let swallow = false;
  let emitted = 0;
  return {
    push(chunk: string): string {
      if (swallow) return "";
      const s = held + (chunk ?? "");
      held = "";
      const i = s.indexOf(FETCH_OPEN);
      if (i !== -1) {
        swallow = true;
        const out = s.slice(0, i);
        emitted += out.length;
        return out;
      }
      // 尾部若恰是开标记的前缀，先扣住，下个分片再定夺
      let keep = 0;
      for (let k = Math.min(s.length, FETCH_OPEN.length - 1); k > 0; k--) {
        if (FETCH_OPEN.startsWith(s.slice(s.length - k))) { keep = k; break; }
      }
      held = keep ? s.slice(s.length - keep) : "";
      const out = s.slice(0, s.length - held.length);
      emitted += out.length;
      return out;
    },
    flush(): string {
      if (swallow) { held = ""; return ""; }
      const out = held;
      held = "";
      emitted += out.length;
      return out;
    },
    swallowed(): boolean { return swallow; },
    emittedLen(): number { return emitted; },
  };
}

/** 一条请求的执行回执（接线层填：状态来自 stepDetailOf，text 是截断过的结果 JSON） */
export interface FetchResult {
  tool: string;
  args: Record<string, unknown>;
  status: "ok" | "missing" | "error" | "stale" | "refused";
  ms: number | null;
  /** 结果正文（JSON 文本，接线层截断过）或「为什么没执行」的人话 */
  text: string;
  reason?: string;
}

function statusZh(s: FetchResult["status"]): string {
  if (s === "ok") return "已取到";
  if (s === "missing") return "没取到（工具回了缺失，不是不存在）";
  if (s === "error") return "取数失败";
  if (s === "stale") return "取到了但不是新数";
  return "未执行";
}

/** 紧凑回显参数（坏形状原样 String()，不抛错）：让模型认得出这条结果对应它哪次请求 */
function argsEcho(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args ?? {});
    return s === "{}" ? "" : s;
  } catch {
    return String(args);
  }
}

/**
 * 渲染补取结果块：这是折回给模型的续答轮里唯一的「新数据段」。
 * 每条自报工具/参数/状态/耗时——出身跟着数据走，和预取块同一套纪律。
 */
export function renderFetchResultsBlock(results: FetchResult[], round: number, malformed: string[] = []): string {
  const left = Math.max(0, MAX_FETCH_ROUNDS - round);
  const lines: string[] = [];
  lines.push(`【系统补数结果（第 ${round}/${MAX_FETCH_ROUNDS} 轮）】（这些是工作台刚才按你的 [[KAIRO_FETCH]] 请求真跑工具取回来的，出处逐条自报）`);
  let n = 0;
  for (const r of results) {
    n++;
    const echo = argsEcho(r.args);
    const why = r.reason ? `（你要的理由：${r.reason}）` : "";
    lines.push(`- ${n}. ${r.tool}${echo ? ` ${echo}` : ""} —— ${statusZh(r.status)}${r.ms != null ? `（${r.ms}ms）` : ""}${why}`);
    lines.push(r.text);
  }
  for (const m of malformed) {
    lines.push(`- ${++n}. （未执行）这条请求不是合法的 JSON 请求块，工作台没有执行，内容截样：${m.slice(0, 120)}`);
  }
  if (!results.length && !malformed.length) {
    lines.push("- （本轮没有可执行的请求：要么没发请求块，要么都被条数上限拦下。）");
  }
  lines.push(
    left > 0
      ? `还缺关键数据可以再发一轮请求块（还剩 ${left} 次机会，每轮最多 ${MAX_REQUESTS_PER_ROUND} 条）；不需要就基于现有数据直接回答用户的问题。不管补没补到，都不要向用户提「工具/调用/请求块」这些通道内部词汇。`
      : `补数机会（${MAX_FETCH_ROUNDS} 轮）已用完：请基于现有数据作答，缺的维度按纪律如实说「工作台没取到」，不要再发请求块。`,
  );
  return lines.join("\n");
}

/** 单轮请求数截断：超额的不执行、如实告知（返回 executed/skipped 两段，接线层拼回执） */
export function splitRequests(requests: FetchRequest[], max: number = MAX_REQUESTS_PER_ROUND): { executed: FetchRequest[]; skipped: FetchRequest[] } {
  return { executed: requests.slice(0, max), skipped: requests.slice(max) };
}

/** 工具是否被文本环开放：不在 TOOLS 注册表或撞黑名单都不开放（注册表校验在接线层做，这里只管黑名单） */
export function isBlockedTool(tool: string): boolean {
  return GATEWAY_LOOP_BLOCKED.includes(tool);
}

/** 给协议卡渲染工具目录：注册表里除黑名单外全量开放，一行一个（描述用工具注册表原文，不开第二份文案） */
export function renderToolCatalog(tools: { name: string; desc: string }[]): string {
  return tools.filter((t) => !isBlockedTool(t.name)).map((t) => `- ${t.name}：${t.desc}`).join("\n");
}

/** 时间线步骤的人话标签（网关环专用）：与 AI 交易员环那份 STEP_LABELS 同步维护，形状钉盯着别漂 */
export const GATEWAY_LOOP_STEP_LABELS: Record<string, string> = {
  tdx_market_overview: "取通达信指数概况（交易所直连快照）",
  tdx_quotes: "取通达信实时行情（含盘口/内外盘）",
  tdx_kline: "取通达信日K（不复权）",
  stock_news: "取个股新闻与公告（这只票自己的消息面）",
  candidate_pool: "读取已冻结候选池（择优素材，池序不是推荐）",
};

// ---------- 补数协议卡（随网关对话轮附在身份卡之后） ----------
//
// 为什么不并进 GATEWAY_BRAIN_BRIEF（model-config-core）：那张卡的第一纪律就是「你没有工具」——
// 文本环没接线时它是真话，接了线它仍是真话（模型依然不能直接调接口，唯一例外是发请求块），
// 两卡分开各自可钉测。协议格式（标记/条数/轮次上限）全部用本模块的单源常量拼，
// 卡与解析器住同一份定义，永不各说各话。

export function gatewayFetchLoopBrief(catalog: string): string {
  return [
    "【工作台补数协议（系统本轮附加，与接入须知第 1 条搭着用）】",
    "第 1 条仍然成立：你没有可直接调用的工具。唯一合法例外——当「[系统按场景自动取数]」块不够答用户的问题时，你可以在回复末尾发出取数请求，工作台会真去本地数据层取，并把结果以「【系统补数结果】」段发回来让你续答。",
    `请求块格式（一条请求一块，一次回复最多 ${MAX_REQUESTS_PER_ROUND} 块；请求块之后一个字都不要再写，收口等系统回数据）：`,
    `${FETCH_OPEN}{"tool":"工具名","args":{...参数...},"reason":"为什么需要这份数据"}${FETCH_CLOSE}`,
    `一个问题最多补 ${MAX_FETCH_ROUNDS} 轮。这条消息里还没有「【系统补数结果】」段时，你请求过的数据就是还没取到——结果回来之前不许说「已经查到」，那和编数字同类是事故。`,
    "开放给文本协议的取数工具（参数照说明给；清单外/回测一律不给发，缺就说缺）：",
    catalog,
    "对用户永远只说人话（「我又查了下」「工作台补了份数据」），别提「工具/调用/请求块/JSON」这些通道内部词。",
  ].join("\n");
}
