// P39 / #75 AI优选战绩层 · 服务端生成与落库（db + 服务端模型通道）
//
// 复用 StrategyPick 一张表：本层只负责「把 AI优选那几只票 + T 日收盘 写进 source=ai_pick 的行」，
// 之后的回填（pickfill）/ 净值（战绩页）全部走现有管线，不另写。
//
// 两种进入方式（都落同一张表、同一层）：
//   ① 服务端自动优选：不传 picks，从当日 layer1 候选（gate/regime 已记具体票的行）里，
//      用 getServerLlm() 拿到的服务端模型通道收窄到 ≤N 只 → 解决「用户不手动用 AI优选也不会触发」。
//   ② 手动结构化结果：前端把已经收窄好的 picks 传进来（用户在对话里让 AI优选挑完、或点「计入战绩」），
//      直接落库，不让模型二次加工。
//
// 诚实边界（与全仓同一条纪律）：
//   - 服务端通道没配 → 如实说「未配置」，绝不造一份假优选；
//   - 当天没候选 → 如实说「无候选可优选」，不落空行；
//   - 模型没返回可解析清单 → 如实说「未解析出」，不拿默认顶替；
//   - 已回填过的行绝不重写（重跑不涨 = 不能造假）。
//
// 数据源：候选的 T 日收盘来自 layer1 行自带的 symbols.close；缺了再查本地粮仓 stock_daily_bar 补。

import { db } from "../../db.ts";
import { shanghaiDate } from "../../desk/session.ts";
import { parseSymbols, symJsonOf, type PickSym } from "./pick-fill-core.ts";
import {
  AI_PICK_SOURCE, AI_PICK_STRATEGY_ID, AI_PICK_MAX,
  buildAiPickPrompt, parseAiPickResponse, narrowChoices, type AiPickCandidate,
} from "./ai-pick-core.ts";
import type { ArchiveResult, ScanMode } from "../screener/persist.ts";
import { getServerLlm } from "../../llm/model-config.ts";

const ADJUST = "qfq";

/** 与 proxy 路由口径一致：base 填不填 /v1 都等价 */
function apiBase(base: string): string {
  return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}

interface ChatMsg { role: "system" | "user" | "assistant"; content: string }

/** 服务端非流式对话（复用模型通道的 baseUrl + key + model，不依赖 proxy 路由的 SSE 路径） */
async function callServerChat(
  channel: { baseUrl: string; apiKey: string; model: string },
  messages: ChatMsg[],
  ms: number,
): Promise<string> {
  const url = apiBase(channel.baseUrl) + "/v1/chat/completions";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${channel.apiKey}` },
      body: JSON.stringify({ model: channel.model, messages, temperature: 0.3, max_tokens: 1500 }),
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string }; choices?: { message?: { content?: string } }[] };
    if (!res.ok) throw new Error(json?.error?.message || `上游 ${res.status}`);
    return json?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

/** 某票某日收盘（qfq）：候选自带的 close 缺失时补查 */
async function closeOf(symbol: string, tradeDate: string): Promise<number | null> {
  try {
    const rows = await db.$queryRawUnsafe<{ close: number | null }[]>(
      `SELECT close FROM stock_daily_bar WHERE symbol = ? AND tradeDate = ? AND adjust = ? LIMIT 1`,
      symbol, tradeDate, ADJUST,
    );
    const c = rows[0]?.close;
    return typeof c === "number" && Number.isFinite(c) ? c : null;
  } catch {
    return null;
  }
}

/** 当日 layer1 候选（gate/regime 且已记具体票），去重成候选池，带 T 日收盘 */
export async function gatherLayer1Candidates(tradeDate: string): Promise<AiPickCandidate[]> {
  const rows = await db.strategyPick.findMany({
    where: { tradeDate, source: { in: ["gate", "regime"] }, symbols: { not: null } },
    select: { symbols: true },
  });
  const map = new Map<string, AiPickCandidate>();
  for (const r of rows) {
    for (const s of parseSymbols(r.symbols)) {
      const key = s.symbol.toUpperCase();
      if (!key) continue;
      if (!map.has(key)) map.set(key, { symbol: s.symbol, name: s.name || "", close: s.close ?? null });
    }
  }
  return [...map.values()];
}

function emptyResult(tradeDate: string, missing: string[], source: string, mode: ScanMode = "full"): ArchiveResult<never> {
  return {
    as_of: shanghaiDate(),
    trade_date: tradeDate,
    missing,
    scanned: 0,
    results: 0,
    items: [],
    unmatched: null,
    source,
    mode,
    delta: { scanned: 0, inserted: 0, updated: 0, unchanged: 0, skippedByCursor: 0, superseded: 0, kept: 0, collapsed: 0 },
  };
}

/** 解析 / 落库共用的写库：已回填过的行不重写；否则按 (tradeDate,strategyId,source) 唯一键 upsert */
async function persistAiPick(tradeDate: string, syms: PickSym[], note: string, basis: string): Promise<{ inserted: number; updated: boolean; keptBackfilled: boolean }> {
  const existing = await db.strategyPick.findFirst({
    where: { tradeDate, strategyId: AI_PICK_STRATEGY_ID, source: AI_PICK_SOURCE },
    select: { id: true, symBackfilledAt: true },
  });
  if (existing?.symBackfilledAt) {
    // 已经回填过：重跑会改动「已经走完的成绩」= 可以造假，直接保留
    return { inserted: 0, updated: false, keptBackfilled: true };
  }
  const data = {
    tradeDate,
    strategyId: AI_PICK_STRATEGY_ID,
    strategyName: "AI优选",
    source: AI_PICK_SOURCE,
    symbols: symJsonOf(syms),
    symbolsNote: note,
    nextDaySymWin: null,
    symBackfilledAt: null,
  };
  if (existing) {
    await db.strategyPick.update({ where: { id: existing.id }, data });
    return { inserted: 0, updated: true, keptBackfilled: false };
  }
  await db.strategyPick.create({ data: { ...data, pickedAt: new Date() } });
  return { inserted: syms.length, updated: false, keptBackfilled: false };
}

async function resolveSyms(cands: AiPickCandidate[], tradeDate: string): Promise<PickSym[]> {
  return Promise.all(cands.map(async (c) => ({
    symbol: c.symbol,
    name: c.name || "",
    close: typeof c.close === "number" && Number.isFinite(c.close) ? c.close : (await closeOf(c.symbol, tradeDate)),
  })));
}

export interface GenerateAiPickOptions {
  /** 显式候选池（不传 = 取当日 layer1）；用于「把某份冻结池交给 AI优选战绩」 */
  candidates?: AiPickCandidate[];
  /** 已经收窄好的结果（手动计入战绩），直接落库，不让模型二次加工 */
  picks?: PickSym[];
  /** 收窄上限（默认 AI_PICK_MAX） */
  topN?: number;
  /** 上游超时（默认 120s） */
  timeoutMs?: number;
}

/**
 * 生成某日的 AI优选战绩层并落库。返回 ArchiveResult 供接口 / 调度器记账（成功/跳过都如实写 missing）。
 * 不抛异常：任何一步走不通都收成「跑了但没落库」的 ArchiveResult，调度器据此记 success + 原因，不谎称失败。
 */
export async function generateAiPickForDate(
  tradeDate: string,
  opts: GenerateAiPickOptions = {},
): Promise<ArchiveResult<never>> {
  const topN = Math.max(1, Math.min(opts.topN ?? AI_PICK_MAX, AI_PICK_MAX));

  // ② 手动结构化结果：直接落库
  if (opts.picks && opts.picks.length) {
    const r = await persistAiPick(tradeDate, opts.picks.slice(0, topN), `手动计入的 AI 优选（${opts.picks.length} 只）`, "前端传入的已收窄清单");
    if (r.keptBackfilled) return emptyResult(tradeDate, ["该日 AI优选已回填过，不重算（重跑会改动已走完的成绩）"], "手动计入");
    return {
      ...emptyResult(tradeDate, [], r.updated ? "手动计入（覆盖未回填的旧行）" : "手动计入", "full"),
      results: opts.picks.length,
      delta: { ...emptyResult(tradeDate, [], "").delta, inserted: r.inserted, updated: r.updated ? 1 : 0 },
    };
  }

  // ① 服务端自动优选：先凑候选池
  const cands = opts.candidates && opts.candidates.length
    ? opts.candidates
    : await gatherLayer1Candidates(tradeDate);
  if (!cands.length) {
    return emptyResult(tradeDate, [`${tradeDate} 当日没有 layer1 候选（gate/regime 都没记具体票），无从优选`], "服务端自动优选");
  }

  const llm = getServerLlm();
  if (!llm.available) {
    return emptyResult(tradeDate, [`未配置服务端模型通道（${llm.reason}），无法自动跑 AI优选；在「设置 → AI 接口」或 .env 配好 LLM_* 后重启即自动生成`], "服务端自动优选（未配置通道）");
  }

  let text: string;
  try {
    text = await callServerChat(
      llm.channel,
      [{ role: "system", content: "你是 A 股量化工作台的 AI优选环节，只输出 JSON，绝不解释。" }, { role: "user", content: buildAiPickPrompt(cands, tradeDate, topN) }],
      opts.timeoutMs ?? 120_000,
    );
  } catch (e) {
    return emptyResult(tradeDate, [`调用服务端模型通道失败：${(e as Error).message}`], "服务端自动优选（模型通道异常）");
  }

  const choices = parseAiPickResponse(text);
  const picked = narrowChoices(choices, cands, topN);
  if (!picked.length) {
    return emptyResult(tradeDate, ["模型没有返回可解析的优选清单（或一只都没选），不落空行"], "服务端自动优选（未解析出）", "full");
  }

  const syms = await resolveSyms(picked, tradeDate);
  const note = `AI 从 ${cands.length} 只候选里优选出 ${picked.length} 只（服务端模型 ${llm.channel.model} 收窄）`;
  const r = await persistAiPick(tradeDate, syms, note, `服务端模型通道 ${llm.channel.model} 从 layer1 候选收窄`);
  if (r.keptBackfilled) return emptyResult(tradeDate, ["该日 AI优选已回填过，不重算"], "服务端自动优选");
  return {
    ...emptyResult(tradeDate, [], r.updated ? "服务端自动优选（覆盖未回填的旧行）" : "服务端自动优选", "full"),
    results: syms.length,
    delta: { ...emptyResult(tradeDate, [], "").delta, inserted: r.inserted, updated: r.updated ? 1 : 0 },
  };
}
