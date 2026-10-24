// Longbridge MCP（美股/港股）— 行情/历史/基本面/新闻适配层（仅服务端）
//
// 数据源：托管长桥 MCP（streamable HTTP，OAuth 2.1），与 china-stock-mcp（A 股）
// 是两套独立的 MCP：URL、Token、工具名全部不同。OpenAPI HMAC（App Key +
// Secret + Token 签名）Muse 无法复现，已放弃，不用它。
//
// 配置（全部从环境变量读，不硬编码 URL/Token，不写日志）：
//   LONGBRIDGE_MCP_URL                    — 如 https://mcp.longbridge.cn/mcp（托管 MCP 端点）
//   LONGBRIDGE_MCP_TOKEN                  — OAuth access_token（Bearer）。未配置时所有函数返回 null，
//                                           调用方保持 missing，不抛错、不阻塞 A 股。
//   LONGBRIDGE_MCP_REFRESH_TOKEN          — OAuth refresh_token，用于自动刷新。
//   LONGBRIDGE_MCP_CLIENT_ID              — DCR 注册的 client_id（公开标识，非密钥），刷新时必需。
//   LONGBRIDGE_MCP_TOKEN_EXPIRES_AT       — access_token 过期时间（毫秒时间戳），exchange/refresh 时写入。
//   LONGBRIDGE_MCP_REFRESH_TOKEN_EXPIRES_AT — refresh_token 过期时间（毫秒时间戳，服务端返回时才记）。
//
// Token 自动刷新（无需用户手动操作、无需浏览器授权）：
//   主动：每次 MCP 调用前，若 access_token 在 5 分钟内过期 → 立即用 refresh_token 换新。
//   被动：MCP 调用返回 401/鉴权失败 → 换新 Token 后重试一次。
//   换新后自动写回 .env（只改长桥相关行）+ 更新本进程内存，无需重启 dev。
//   refresh_token 失效（服务端 invalid_grant）→ 抛 LongbridgeRefreshExpiredError，
//   调用方通过 getLongbridgeAuthStatus() 看到 needsReauth，需用户重新走一次浏览器授权。
//   注意：长桥不提供“永久 Token”；access_token 约 14 天（MCP 端点实测 expires_in 1209600），
//   refresh_token 有效期官方未公布，每次刷新若返回新 refresh_token 则窗口重置，只要按时刷新即可一直续下去。
//
// OAuth（托管 OAuth 2.1，PKCE，公开客户端，无 client_secret）：
//   元数据（实测 2026-10-16）：
//     issuer https://mcp.longbridge.cn
//     authorize https://openapi.longbridge.cn/oauth2/authorize
//     token     https://mcp.longbridge.cn/oauth2/token
//     revoke    https://mcp.longbridge.cn/oauth2/revoke
//     register  https://openapi.longbridge.cn/oauth2/register（DCR）
//     scopes_supported ["4","6","10","11"]，grant authorization_code + refresh_token，
//     token_endpoint_auth_methods ["none"]，code_challenge S256/plain。
//   流程：DCR 注册（或用已注册 client）→ 浏览器打开 buildLongbridgeAuthorizeUrl()
//   → 用户登录并授权 → 回调带 ?code= → exchangeLongbridgeAuthCode(code, verifier)
//   → 得到 access_token + refresh_token → 写入 .env（LONGBRIDGE_MCP_TOKEN）→ 重启 dev。
//   本模块不自动跑 OAuth（需要用户在浏览器里登录授权），只提供 URL 构造与换 token。
//
// 工具名（实测 2026-10-16，tools/list 共 190 个，Token 有效）：
//   实时行情 = `quote`（不是 realtime_quote——调 realtime_quote 报 tool not found）。
//   `quote` 要求 {symbols: [...]} 数组（单 symbol 报 missing field `symbols`），返回
//   per-symbol {symbol, last_done, prev_close, open, high, low, timestamp, volume,
//   turnover, trade_status}（值多为字符串，无 change_rate 字段，涨跌幅需自算）。
//   K 线 = `candlesticks`（{symbol, period:"day", count}，忽略 start_date/end_date，
//   返回最近 count 根；起止需客户端按日期过滤）。
//   估值 = `valuation`（{symbol}，返回 {metrics:{pe:{low,median,high,desc,list}}, range}，
//   仅有 PE，无 PB/市值/ROE/EPS/股息率；当前 PE 取 list 最后一值或 desc 解析）。
//   新闻 = `news`（{symbol}，返回 items[]{id, title, description, url, published_at}，
//   无 source 字段，内容在 description 不在 content/summary）。
// 动态解析：先找候选名在真实列表里是否存在，找不到则按关键字回退；全部找不到
// 时返回首选候选，调用报错走 null，不编数据。
//
// 符号格式：长桥用 NVDA.US / AAPL.US / VOO.US / TSM.US（美股），00700.HK / 09988.HK
// （港股）。normalizeLongbridgeSymbol：裸代码默认 .US；6 位数字默认 .HK；已有后缀保持。
//
// 限流：底层无全局节流；本模块批量逐只、间隔 200ms、上限 20 只，单只失败跳过。

import { promises as fs } from "fs";
import path from "path";
import { McpHttpClient } from "@/lib/quant/data/mcp-http-client";

// ---------- 配置 ----------

export function longbridgeMcpConfigured(): boolean {
  return Boolean((process.env.LONGBRIDGE_MCP_URL ?? "").trim() && (process.env.LONGBRIDGE_MCP_TOKEN ?? "").trim());
}

let client: McpHttpClient | null = null;
let configuredFor = "";

function ensureClient(): McpHttpClient | null {
  const url = (process.env.LONGBRIDGE_MCP_URL ?? "").trim();
  const token = (process.env.LONGBRIDGE_MCP_TOKEN ?? "").trim();
  if (!url || !token) return null;
  const key = `${url}|${token.slice(0, 8)}`;
  if (!client || configuredFor !== key) {
    client = new McpHttpClient({ url, authToken: () => (process.env.LONGBRIDGE_MCP_TOKEN ?? "").trim() || null, clientName: "mydesk-longbridge" });
    configuredFor = key;
  }
  return client;
}

// ---------- Token 持久化（.env + 内存） ----------

export interface LongbridgeTokens {
  accessToken: string;
  refreshToken?: string | null;
  clientId?: string | null;
  /** access_token 有效期（秒），服务端返回的 expires_in */
  expiresIn?: number | null;
  /** refresh_token 有效期（秒），服务端若返回 refresh_token_expires_in / refresh_expires_in 则记入 */
  refreshExpiresIn?: number | null;
}

function upsertEnvLine(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}="${value.replace(/"/g, "")}"`;
  if (re.test(text)) return text.replace(re, line);
  return text.endsWith("\n") || text === "" ? `${text}${line}\n` : `${text}\n${line}\n`;
}

/**
 * 保存长桥 Token 到内存 + .env（只改长桥相关行，其余行原样保留）。
 * 由 exchange / callback / refresh 三处共用，避免三份 upsert 逻辑漂移。
 * 注意：只更新调用方所在进程的 process.env；若由独立脚本写 .env，
 * 正在跑的 dev 进程需重启才读到新 Token（经 dev 内 API 路由刷新则无需重启）。
 */
export async function saveLongbridgeTokens(t: LongbridgeTokens): Promise<{ tokenExpiresAt: number | null; refreshExpiresAt: number | null }> {
  const now = Date.now();
  const tokenExpiresAt = typeof t.expiresIn === "number" && t.expiresIn > 0 ? now + t.expiresIn * 1000 : null;
  const refreshExpiresAt = typeof t.refreshExpiresIn === "number" && t.refreshExpiresIn > 0 ? now + t.refreshExpiresIn * 1000 : null;
  process.env.LONGBRIDGE_MCP_TOKEN = t.accessToken;
  if (t.refreshToken) process.env.LONGBRIDGE_MCP_REFRESH_TOKEN = t.refreshToken;
  if (t.clientId) process.env.LONGBRIDGE_MCP_CLIENT_ID = t.clientId;
  if (tokenExpiresAt) process.env.LONGBRIDGE_MCP_TOKEN_EXPIRES_AT = String(tokenExpiresAt);
  if (refreshExpiresAt) process.env.LONGBRIDGE_MCP_REFRESH_TOKEN_EXPIRES_AT = String(refreshExpiresAt);
  // refresh 失败标记清零（新 Token 已生效）
  lastRefreshError = null;
  try {
    const envPath = path.join(process.cwd(), ".env");
    let envText = "";
    try { envText = await fs.readFile(envPath, "utf8"); } catch { envText = ""; }
    envText = upsertEnvLine(envText, "LONGBRIDGE_MCP_URL", (process.env.LONGBRIDGE_MCP_URL ?? "").trim() || "https://mcp.longbridge.cn/mcp");
    envText = upsertEnvLine(envText, "LONGBRIDGE_MCP_TOKEN", t.accessToken);
    if (t.refreshToken) envText = upsertEnvLine(envText, "LONGBRIDGE_MCP_REFRESH_TOKEN", t.refreshToken);
    if (t.clientId) envText = upsertEnvLine(envText, "LONGBRIDGE_MCP_CLIENT_ID", t.clientId);
    if (tokenExpiresAt) envText = upsertEnvLine(envText, "LONGBRIDGE_MCP_TOKEN_EXPIRES_AT", String(tokenExpiresAt));
    if (refreshExpiresAt) envText = upsertEnvLine(envText, "LONGBRIDGE_MCP_REFRESH_TOKEN_EXPIRES_AT", String(refreshExpiresAt));
    await fs.writeFile(envPath, envText, "utf8");
  } catch {
    // .env 写失败不阻断内存 Token（本次进程内仍可用新 Token），调用方按需处理
  }
  return { tokenExpiresAt, refreshExpiresAt };
}

// ---------- Token 自动刷新 ----------

/** refresh_token 已失效（服务端返回 invalid_grant）：必须重新走浏览器授权，自动刷新无法续命。 */
export class LongbridgeRefreshExpiredError extends Error {
  constructor() { super("refresh_token 已过期，需重新授权"); this.name = "LongbridgeRefreshExpiredError"; }
}

/** 主动刷新阈值：access_token 过期前 5 分钟即刷新（跟长桥官方 SDK 策略一致），避免第一跳请求被阻塞。 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
let refreshPromise: Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number | null; refreshExpiresIn: number | null; tokenExpiresAt: number | null; refreshExpiresAt: number | null }> | null = null;
let lastRefreshError: string | null = null;

export function getLongbridgeAuthStatus(): { configured: boolean; needsReauth: boolean; reason: string | null; tokenExpiresAt: number | null } {
  const expiresAt = Number(process.env.LONGBRIDGE_MCP_TOKEN_EXPIRES_AT ?? "");
  return {
    configured: longbridgeMcpConfigured(),
    needsReauth: lastRefreshError != null,
    reason: lastRefreshError,
    tokenExpiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
  };
}

function isAuthError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /401|403|unauthorized|invalid.?token|token.?expired|expired.?token|missing or invalid authorization/i.test(msg);
}

async function doRefresh(clientId: string, refreshToken: string): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number | null; refreshExpiresIn: number | null }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  const res = await fetch(LONGBRIDGE_OAUTH.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  const text = await res.text().catch(() => "");
  let j: Record<string, unknown> = {};
  try { j = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* 非 JSON 报错按 HTTP 状态处理 */ }
  if (!res.ok) {
    const errCode = typeof j["error"] === "string" ? (j["error"] as string) : "";
    if (res.status === 400 && (errCode === "invalid_grant" || /invalid_grant|invalid.?refresh/i.test(text))) {
      throw new LongbridgeRefreshExpiredError();
    }
    throw new Error(`长桥刷新 token 失败 HTTP ${res.status}`);
  }
  const at = typeof j["access_token"] === "string" ? (j["access_token"] as string) : "";
  if (!at) throw new Error("长桥刷新 token 未返回 access_token");
  const rt = typeof j["refresh_token"] === "string" ? (j["refresh_token"] as string) : null;
  const expiresIn = typeof j["expires_in"] === "number" ? (j["expires_in"] as number) : null;
  const refreshExpiresIn =
    typeof j["refresh_token_expires_in"] === "number" ? (j["refresh_token_expires_in"] as number)
    : typeof j["refresh_expires_in"] === "number" ? (j["refresh_expires_in"] as number)
    : null;
  return { accessToken: at, refreshToken: rt, expiresIn, refreshExpiresIn };
}

/**
 * 用 refresh_token 换新 access_token（+ 可能轮换的新 refresh_token），自动写回 .env。
 * 单飞行：并发调用共享同一次刷新，不会用同一枚 refresh_token 重复换（避免旋转冲突）。
 * refresh_token 失效时抛 LongbridgeRefreshExpiredError（需重新授权）；其余失败抛普通 Error。
 * 无需用户浏览器授权、无需手动操作。注意：refresh_token 本身也有有效期（长桥未公布时长），
 * 每次刷新若服务端返回新 refresh_token 则窗口重置；只要刷新按时发生，理论上一直续下去。
 */
export async function refreshLongbridgeAccessToken(opts?: { clientId?: string }): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number | null; refreshExpiresIn: number | null; tokenExpiresAt: number | null; refreshExpiresAt: number | null }> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const clientId = (opts?.clientId ?? process.env.LONGBRIDGE_MCP_CLIENT_ID ?? "").trim();
    const refreshToken = (process.env.LONGBRIDGE_MCP_REFRESH_TOKEN ?? "").trim();
    if (!clientId) throw new Error("缺少 LONGBRIDGE_MCP_CLIENT_ID，无法自动刷新（需首次授权时保存 client_id）");
    if (!refreshToken) throw new Error("缺少 LONGBRIDGE_MCP_REFRESH_TOKEN，无法自动刷新");
    const r = await doRefresh(clientId, refreshToken);
    // 服务端未返回新 refresh_token 时沿用旧的（不清空，否则下次无法刷新）
    const saved = await saveLongbridgeTokens({
      accessToken: r.accessToken,
      refreshToken: r.refreshToken ?? refreshToken,
      clientId,
      expiresIn: r.expiresIn,
      refreshExpiresIn: r.refreshExpiresIn,
    });
    return { ...r, refreshToken: r.refreshToken ?? refreshToken, tokenExpiresAt: saved.tokenExpiresAt, refreshExpiresAt: saved.refreshExpiresAt };
  })();
  try {
    return await refreshPromise;
  } catch (e) {
    if (e instanceof LongbridgeRefreshExpiredError) lastRefreshError = e.message;
    throw e;
  } finally {
    refreshPromise = null;
  }
}

/**
 * 主动刷新检查：access_token 在 5 分钟内过期 → 立即刷新。
 * 无 LONGBRIDGE_MCP_TOKEN_EXPIRES_AT（旧 Token、首次授权前未记）时跳过主动刷新，
 * 靠调用失败后的 401 被动刷新兜底。
 */
export async function ensureLongbridgeTokenFresh(): Promise<void> {
  const expiresAt = Number(process.env.LONGBRIDGE_MCP_TOKEN_EXPIRES_AT ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return;
  if (Date.now() > expiresAt - REFRESH_SKEW_MS) {
    await refreshLongbridgeAccessToken();
  }
}

// ---------- 符号 ----------

import type { MarketKind } from "./market-kind";

/**
 * 长桥符号规范化。market 不传时按旧启发式（裸 5 位数字 → .HK，裸字母 → .US）；
 * market 传了则严格按该市场规范化，形态不符或后缀与市场矛盾时返回 ""（缺失，
 * 绝不跨市场映射——例如 US 页输入 00700 绝不变成 00700.HK 去查港股）。
 * "NVDA" → "NVDA.US"；"00700" → "00700.HK"；"NVDA.US"/"00700.HK" 保持；非法返回 ""
 */
export function normalizeLongbridgeSymbol(symbol: string, market?: MarketKind): string {
  const s = symbol.trim().toUpperCase();
  if (!s) return "";
  if (market) {
    if (market === "HK") {
      if (/^\d{5}\.HK$/.test(s)) return s;
      if (/^\d{5}$/.test(s)) return `${s}.HK`;
      return "";
    }
    // US
    if (/^[A-Z]{1,6}(\.[A-Z]{1,2})?\.US$/.test(s)) return s;
    if (/^[A-Z]{1,6}(\.[A-Z]{1,2})?$/.test(s)) return `${s}.US`;
    return "";
  }
  if (/^([A-Z]{1,6}|\d{5})\.(US|HK)$/.test(s)) return s;
  if (/^\d{5}$/.test(s)) return `${s}.HK`;
  if (/^[A-Z]{1,6}$/.test(s)) return `${s}.US`;
  if (/^[A-Z]+\.[A-Z]+$/.test(s)) return s;
  return "";
}

// ---------- 宽容解析 ----------

function numOr(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

function pickNum(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickStr(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "" && String(v) !== "-") return String(v);
  }
  return null;
}

/** MCP 返回形态不定：structuredContent 数组 / {data:[]} / {result: "json字符串"} / 单对象，宽容解包 */
function unwrapRows(sc: unknown): Record<string, unknown>[] {
  if (Array.isArray(sc)) return sc as Record<string, unknown>[];
  if (sc && typeof sc === "object") {
    const obj = sc as Record<string, unknown>;
    if (typeof obj.result === "string") {
      try {
        const parsed = JSON.parse(obj.result);
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    }
    if (Array.isArray(obj.data)) return obj.data as Record<string, unknown>[];
    // 单对象行（如实时行情直接返回一个对象）
    const keys = Object.keys(obj);
    if (keys.length && keys.some((k) => /price|close|last|symbol|code/i.test(k))) return [obj];
  }
  return [];
}

// ---------- 工具名动态解析 ----------

let toolNamesCache: string[] | null = null;

async function listToolNames(): Promise<string[]> {
  if (toolNamesCache) return toolNamesCache;
  const c = ensureClient();
  if (!c) return [];
  try {
    await ensureLongbridgeTokenFresh();
  } catch (e) {
    if (e instanceof LongbridgeRefreshExpiredError) return [];
    // 瞬时刷新失败不阻断：用旧 Token 试一次，401 再走被动刷新
  }
  try {
    const tools = await c.listTools();
    toolNamesCache = tools.map((t) => t.name);
    return toolNamesCache;
  } catch (e) {
    if (isAuthError(e)) {
      try {
        await refreshLongbridgeAccessToken();
        // 刷新后 Token 变了，ensureClient 重建客户端（新会话），重试用新客户端
        const c2 = ensureClient();
        if (!c2) return [];
        const tools = await c2.listTools();
        toolNamesCache = tools.map((t) => t.name);
        return toolNamesCache;
      } catch (re) {
        if (re instanceof LongbridgeRefreshExpiredError) return [];
      }
    }
    return [];
  }
}

/** 在真实工具列表里找首个存在的候选名；都找不到则返回首选候选（让调用报错走 null）。 */
async function resolveTool(candidates: string[], keywords: string[]): Promise<string> {
  const names = await listToolNames();
  if (names.length) {
    for (const cand of candidates) if (names.includes(cand)) return cand;
    const lower = names.map((n) => n.toLowerCase());
    for (let i = 0; i < names.length; i++) {
      if (keywords.every((kw) => lower[i].includes(kw))) return names[i];
    }
  }
  return candidates[0];
}

async function callLbTool(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const c = ensureClient();
  if (!c) return [];
  try {
    await ensureLongbridgeTokenFresh();
  } catch (e) {
    if (e instanceof LongbridgeRefreshExpiredError) return [];
    // 瞬时刷新失败不阻断：用旧 Token 试一次，401 再走被动刷新
  }
  try {
    const res = await c.callTool(tool, args);
    return unwrapRows(res);
  } catch (e) {
    if (!isAuthError(e)) throw e;
    // 被动刷新：Token 过期导致 401 → 换新 Token 后重试一次（用重建的新客户端，新会话）
    await refreshLongbridgeAccessToken();
    const c2 = ensureClient();
    if (!c2) return [];
    const res = await c2.callTool(tool, args);
    return unwrapRows(res);
  }
}

// ---------- 报价 ----------

export interface LongbridgeQuote {
  symbol: string; // NVDA.US
  name: string | null;
  price: number;
  changePct: number | null; // 涨跌幅 %
  change: number | null; // 涨跌额
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null; // 股
  turnover: number | null; // 成交额（元/美元，原值）
  market: string; // US / HK
  date: string;
  source: string;
}

function parseQuoteRow(row: Record<string, unknown>, symbol: string): LongbridgeQuote | null {
  const price = pickNum(row, ["last_done", "last_price", "last", "price", "close", "current_price", "最新价"]);
  if (price == null) return null;
  const prevClose = pickNum(row, ["prev_close", "previous_close", "pre_close", "昨收", "prevClose"]);
  // quote 工具不返回 change_rate/change 字段（实测），用 price 与 prevClose 自算。
  const change = pickNum(row, ["change", "chg", "涨跌额", "price_change"]) ?? (prevClose != null ? price - prevClose : null);
  const changePct = pickNum(row, ["change_percentage", "change_pct", "chg_pct", "pct_change", "涨跌幅", "change_percent", "change_rate"])
    ?? (prevClose != null && prevClose !== 0 && change != null ? (change / prevClose) * 100 : null);
  const rawDate = pickStr(row, ["date", "trade_date", "timestamp", "time", "日期"]) ?? "";
  // timestamp 为 ISO（2026-10-15T20:00:00Z），统一取 YYYY-MM-DD。
  const date = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : rawDate;
  const market = symbol.endsWith(".HK") ? "HK" : "US";
  return {
    symbol,
    name: pickStr(row, ["name", "symbol_name", "stock_name", "名称", "security_name"]),
    price,
    changePct,
    change,
    open: pickNum(row, ["open", "open_price", "开盘"]),
    high: pickNum(row, ["high", "high_price", "最高"]),
    low: pickNum(row, ["low", "low_price", "最低"]),
    prevClose,
    volume: pickNum(row, ["volume", "vol", "成交量", "total_volume"]),
    turnover: pickNum(row, ["turnover", "amount", "成交额", "total_turnover"]),
    market,
    date,
    source: "longbridge-mcp · quote",
  };
}

/** 单只实时报价：NVDA / AAPL / VOO / 00700 等。未配置/失败/无数据返回 null。 */
export async function fetchLongbridgeQuote(symbol: string, market?: MarketKind): Promise<LongbridgeQuote | null> {
  const sym = normalizeLongbridgeSymbol(symbol, market);
  if (!sym || !ensureClient()) return null;
  try {
    // 实测工具名就是 `quote`（realtime_quote 不存在）；只接受 symbols 数组。
    const tool = await resolveTool(["quote"], ["quote"]);
    const rows = await callLbTool(tool, { symbols: [sym] });
    const row = rows[0];
    if (!row) return null;
    return parseQuoteRow(row, sym);
  } catch {
    return null;
  }
}

// ---------- 历史 K 线 ----------

export interface LongbridgeBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
  amount: number | null;
}

function parseHistRows(rows: Record<string, unknown>[]): LongbridgeBar[] {
  const out: LongbridgeBar[] = [];
  for (const r of rows) {
    const date = pickStr(r, ["date", "trade_date", "time", "日期", "timestamp"]);
    const o = pickNum(r, ["open", "open_price", "开盘"]);
    const c = pickNum(r, ["close", "close_price", "收盘"]);
    const h = pickNum(r, ["high", "high_price", "最高"]);
    const l = pickNum(r, ["low", "low_price", "最低"]);
    if (!date || o == null || c == null || h == null || l == null) continue;
    out.push({
      date: date.slice(0, 10),
      o, h, l, c,
      v: pickNum(r, ["volume", "vol", "成交量"]),
      amount: pickNum(r, ["turnover", "amount", "成交额"]),
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 单只历史日 K：start/end 为 YYYY-MM-DD。candlesticks 忽略起止日期，只认 count，
 *  故按区间算 count 拉最近 N 根，再按 [start, end] 过滤。失败返回 null。 */
export async function fetchLongbridgeHist(symbol: string, start: string, end: string, market?: MarketKind): Promise<LongbridgeBar[] | null> {
  const sym = normalizeLongbridgeSymbol(symbol, market);
  if (!sym || !ensureClient()) return null;
  try {
    const tool = await resolveTool(["candlesticks", "quote_history_candlesticks", "history_candlesticks"], ["candle"]);
    // 交易日约占自然日的 5/7，留 20 根缓冲，上限 1000（服务端 max）。
    const days = Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 864e5);
    const count = Math.min(1000, Math.max(20, Math.ceil(days * 1.6) + 20));
    const rows = await callLbTool(tool, { symbol: sym, period: "day", count });
    const bars = parseHistRows(rows).filter((b) => b.date >= start && b.date <= end);
    return bars.length ? bars : null;
  } catch {
    return null;
  }
}

// ---------- 基本面 / 估值 ----------

export interface LongbridgeFundamentals {
  symbol: string;
  name: string | null;
  pe: number | null; // PE(TTM)
  pb: number | null; // PB
  marketCap: number | null; // 总市值（原值，美元/港元）
  roe: number | null; // ROE %
  eps: number | null;
  dividendYield: number | null; // 股息率 %
  date: string;
  source: string;
}

function parseFundamentalsRow(row: Record<string, unknown>, symbol: string): LongbridgeFundamentals | null {
  // valuation 工具返回嵌套 {metrics:{pe:{low,median,high,desc,list}}}，仅有 PE。
  // 当前 PE 取 list 最后一值（历史日值序列的最新值），失败时从 desc 解析“当前市盈率 X”。
  let pe = pickNum(row, ["pe_ratio", "pe", "pe_ttm", "市盈率", "PE"]);
  const metrics = row["metrics"];
  if (pe == null && metrics && typeof metrics === "object") {
    const peObj = (metrics as Record<string, unknown>)["pe"];
    if (peObj && typeof peObj === "object") {
      const list = (peObj as Record<string, unknown>)["list"];
      if (Array.isArray(list) && list.length) {
        const last = list[list.length - 1] as Record<string, unknown>;
        pe = pickNum(last, ["value"]);
      }
      if (pe == null) {
        const desc = (peObj as Record<string, unknown>)["desc"];
        const m = typeof desc === "string" ? desc.match(/当前市盈率\s*([\d.]+)/) : null;
        pe = m ? parseFloat(m[1]) : null;
      }
    }
  }
  const pb = pickNum(row, ["pb_ratio", "pb", "市净率", "PB"]);
  const mc = pickNum(row, ["market_cap", "market_capitalization", "总市值", "marketCap"]);
  const roe = pickNum(row, ["roe", "return_on_equity", "净资产收益率"]);
  const eps = pickNum(row, ["eps", "eps_ttm", "每股收益"]);
  const dy = pickNum(row, ["dividend_yield", "div_yield", "股息率"]);
  if (pe == null && pb == null && mc == null && roe == null && eps == null && dy == null) return null;
  return {
    symbol,
    name: pickStr(row, ["name", "symbol_name", "stock_name", "名称"]),
    pe, pb, marketCap: mc, roe, eps, dividendYield: dy,
    date: pickStr(row, ["date", "trade_date", "日期"]) ?? "",
    source: "longbridge-mcp · valuation",
  };
}

/** 单只基本面/估值：PE/PB/市值/ROE/EPS/股息率。失败返回 null。 */
export async function fetchLongbridgeFundamentals(symbol: string, market?: MarketKind): Promise<LongbridgeFundamentals | null> {
  const sym = normalizeLongbridgeSymbol(symbol, market);
  if (!sym || !ensureClient()) return null;
  try {
    const tool = await resolveTool(["valuation", "financial_report", "get_valuation"], ["valuation"]);
    const rows = await callLbTool(tool, { symbol: sym, symbols: [sym] });
    const row = rows[0];
    if (!row) return null;
    return parseFundamentalsRow(row, sym);
  } catch {
    return null;
  }
}

// ---------- 新闻 ----------

export interface LongbridgeNewsItem {
  title: string;
  time: string | null;
  source: string | null;
  url: string | null;
  content: string | null;
}

/** 单只新闻：失败返回 null。 */
export async function fetchLongbridgeNews(symbol: string, limit = 6, market?: MarketKind): Promise<LongbridgeNewsItem[] | null> {
  const sym = normalizeLongbridgeSymbol(symbol, market);
  if (!sym || !ensureClient()) return null;
  try {
    const tool = await resolveTool(["news", "news_list", "get_news"], ["news"]);
    // news 只接受 {symbol}（实测），多余字段不传；limit 由客户端 slice。
    const rows = await callLbTool(tool, { symbol: sym });
    const items = rows.slice(0, limit).map((r) => ({
      title: pickStr(r, ["title", "标题", "headline"]) ?? "",
      time: pickStr(r, ["published_at", "publish_time", "time", "日期", "created_at"]),
      source: pickStr(r, ["source", "来源", "provider"]),
      url: pickStr(r, ["url", "link", "链接"]),
      content: pickStr(r, ["description", "content", "summary", "内容", "摘要"]),
    })).filter((x) => x.title);
    return items.length ? items : null;
  } catch {
    return null;
  }
}

// ---------- 批量 ----------

const BATCH_LIMIT = 20;
const BATCH_GAP_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchLongbridgeBatch<T>(
  symbols: string[],
  fn: (symbol: string) => Promise<T | null>,
  opts?: { market?: MarketKind },
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const uniq = [...new Set(symbols.map((s) => normalizeLongbridgeSymbol(s, opts?.market)).filter(Boolean))].slice(0, BATCH_LIMIT);
  for (const s of uniq) {
    try {
      const r = await fn(s);
      if (r != null) out.set(s, r);
    } catch {
      // 单只失败跳过
    }
    await sleep(BATCH_GAP_MS);
  }
  return out;
}

// ---------- OAuth 辅助（不自动跑，需要用户在浏览器里授权） ----------

export const LONGBRIDGE_OAUTH = {
  issuer: "https://mcp.longbridge.cn",
  authorize: "https://openapi.longbridge.cn/oauth2/authorize",
  token: "https://mcp.longbridge.cn/oauth2/token",
  revoke: "https://mcp.longbridge.cn/oauth2/revoke",
  register: "https://openapi.longbridge.cn/oauth2/register",
  // MCP 元数据 scopes_supported（数字串，长桥口径；授权时原样传）
  scopes: ["4", "6", "10", "11"],
} as const;

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 生成 PKCE verifier + challenge（S256）。调用方保存 verifier，换 token 时传回。 */
export function newPkcePair(): { verifier: string; challenge: string } {
  const rand = new Uint8Array(32);
  crypto.getRandomValues(rand);
  const verifier = base64Url(rand);
  // 同步版只能用 plain（challenge = verifier）；服务端要求 S256 时用 newPkcePairS256（异步）。
  return { verifier, challenge: verifier };
}

/** 异步 S256 版 PKCE：challenge = base64url(SHA256(verifier))，符合服务端首选。 */
export async function newPkcePairS256(): Promise<{ verifier: string; challenge: string }> {
  const rand = new Uint8Array(32);
  crypto.getRandomValues(rand);
  const verifier = base64Url(rand);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** 构造浏览器授权 URL：用户打开 → 登录长桥并授权 → 回调带 ?code=。clientId 来自 DCR 注册或已注册客户端。 */
export function buildLongbridgeAuthorizeUrl(opts: { clientId: string; redirectUri: string; challenge: string; challengeMethod?: "S256" | "plain"; state?: string }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_challenge: opts.challenge,
    code_challenge_method: opts.challengeMethod ?? "S256",
    scope: LONGBRIDGE_OAUTH.scopes.join(" "),
  });
  if (opts.state) q.set("state", opts.state);
  return `${LONGBRIDGE_OAUTH.authorize}?${q.toString()}`;
}

/** 用授权码换 access_token + refresh_token（公开客户端，无 client_secret）。失败抛错，调用方捕获。 */
export async function exchangeLongbridgeAuthCode(opts: { code: string; verifier: string; clientId: string; redirectUri: string }): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number | null; refreshExpiresIn: number | null }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
  });
  const res = await fetch(LONGBRIDGE_OAUTH.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`长桥 OAuth 换 token 失败 HTTP ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  const at = typeof j["access_token"] === "string" ? (j["access_token"] as string) : "";
  if (!at) throw new Error("长桥 OAuth 换 token 未返回 access_token");
  return {
    accessToken: at,
    refreshToken: typeof j["refresh_token"] === "string" ? (j["refresh_token"] as string) : null,
    expiresIn: typeof j["expires_in"] === "number" ? (j["expires_in"] as number) : null,
    refreshExpiresIn:
      typeof j["refresh_token_expires_in"] === "number" ? (j["refresh_token_expires_in"] as number)
      : typeof j["refresh_expires_in"] === "number" ? (j["refresh_expires_in"] as number)
      : null,
  };
}
