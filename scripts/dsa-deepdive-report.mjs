#!/usr/bin/env node
// MyDesk DSA 深挖报告生成器（pdfkit 版，复用日报的 CJK 字体处理）
// 用法：cd ~/workspace/kairotrend-p1 && node scripts/dsa-deepdive-report.mjs [决策日YYYY-MM-DD]
// 不传日期时：取 <= 昨日（上海时区）的最近一个 AI 优选决策日。
// 23:30 当日版 cron 会显式传入当日日期，此时按传入日期精确匹配（无该日版本则 NO_PICKS，不回退旧版）。
// 数据缺失留空，绝不编造。
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import PDFDocument from "pdfkit";
import * as fontkit from "fontkit";
import { loadBars, computeTrendStage, symbolOf, trendShortLabel, trendLine } from "./trend-stage.mjs";

const HOME = process.env.HOME || "/home/hatch";
const REPO = path.join(HOME, "workspace/kairotrend-p1");
const DSA_DB = path.join(HOME, "workspace/daily_stock_analysis/data/stock_analysis.db");
const DESK_DB = path.join(REPO, "prisma/prisma/db/custom.db");
const VERSION_DIR = path.join(REPO, "data/ai-pick-versions");
const CAL_PATH = path.join(REPO, "data/trade-calendar.json");
const GOAL = path.join(HOME, "workspace/goals/mydesk-market-data-and-stock-picking-workflow");
const FILES_DIR = path.join(GOAL, "files");
const YOUR_FILES = path.join(HOME, "workspace/your_files");
const TREND_LEDGER = path.join(GOAL, "hidden_files/pick-trend-stages.jsonl");

const FONT_CANDIDATES = [
  process.env.PDF_CJK_FONT,
  process.env.PDF_CJK_FONT_REGULAR,
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
].filter(Boolean);
const FONT_BOLD_CANDIDATES = [
  process.env.PDF_CJK_FONT_BOLD,
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
].filter(Boolean);

function shanghaiNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
}
function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function isTradingDay(dateStr) {
  try {
    const cal = JSON.parse(fs.readFileSync(CAL_PATH, "utf-8"));
    let days = cal.days || cal.trading_days || cal;
    if (!Array.isArray(days)) days = Object.keys(days);
    return days.includes(dateStr);
  } catch (e) {
    console.error(`WARN trade calendar unreadable: ${e.message}`);
    return false;
  }
}

function latestDecisionDate(beforeStr) {
  if (!fs.existsSync(VERSION_DIR)) return null;
  const dates = new Set();
  for (const fn of fs.readdirSync(VERSION_DIR)) {
    const m = fn.match(/^(\d{4}-\d{2}-\d{2})-\d{6}\.json$/);
    if (m && m[1] <= beforeStr) dates.add(m[1]);
  }
  const sorted = [...dates].sort();
  return sorted.length ? sorted[sorted.length - 1] : null;
}

function loadPicks(decisionDate) {
  const codes = new Map(); // bare6 -> name
  for (const fn of fs.readdirSync(VERSION_DIR).sort()) {
    if (!fn.startsWith(decisionDate + "-")) continue;
    const d = JSON.parse(fs.readFileSync(path.join(VERSION_DIR, fn), "utf-8"));
    for (const p of d.picks || []) {
      const sym = String(p.symbol || p.code || "").trim();
      const bare = sym.replace(/\.(SH|SZ|BJ)$/, "");
      if (/^\d{6}$/.test(bare) && !codes.has(bare)) codes.set(bare, p.name || "");
    }
  }
  return codes;
}

// 新浪个股资金流（MyDesk 同款备胎源）：直连可用，不封 IP
// 口径：netamount 是新浪日度净额（≈主力净流入），与东财主力净额不完全等价，必须标「新浪口径」
function sinaCodeOf(code6) {
  if (!/^\d{6}$/.test(code6)) return null;
  if (code6.startsWith("92") || code6.startsWith("8")) return `bj${code6}`;
  if (code6.startsWith("6") || code6.startsWith("9")) return `sh${code6}`;
  return `sz${code6}`;
}

async function fetchSinaFundFlow(code6, days = 5) {
  const pre = sinaCodeOf(code6);
  if (!pre) return null;
  const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/` +
    `MoneyFlow.ssl_qsfx_zjlrqs?page=1&num=${days}&sort=opendate&asc=0&daima=${pre}`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const payload = await resp.json();
    if (!Array.isArray(payload)) return null;
    const out = [];
    for (const row of payload) {
      const date = typeof row.opendate === "string" ? row.opendate.trim() : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const net = typeof row.netamount === "number" ? row.netamount : parseFloat(String(row.netamount ?? ""));
      if (!Number.isFinite(net)) continue;
      out.push({ date, netYi: net / 1e8 });
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// ============ 东财个股新闻（MyDesk stock-news.ts 同款）============
// 口径：东财 search-api-web 的 cmsArticleWebOld，与东财网页个股频道「相关新闻资讯」同一数据源
async function fetchEmStockNews(keyword, limit = 5) {
  const kw = (keyword ?? "").trim();
  if (!kw) return null;
  const param = {
    uid: "", keyword: kw, type: ["cmsArticleWebOld"], client: "web", clientType: "web", clientVersion: "curr",
    param: { cmsArticleWebOld: { searchScope: "default", sort: "time", pageIndex: 1, pageSize: Math.min(10, Math.max(1, limit)), preTag: "", postTag: "" } },
  };
  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=x&param=${encodeURIComponent(JSON.stringify(param))}`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.eastmoney.com/" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    const a = text.indexOf("(");
    const b = text.lastIndexOf(")");
    const body = a >= 0 && b > a ? text.slice(a + 1, b) : text;
    const j = JSON.parse(body);
    const rows = j?.result?.cmsArticleWebOld;
    if (!Array.isArray(rows)) return null;
    return rows.slice(0, limit).map((r) => ({
      title: String(r.title ?? "").replace(/\s+/g, " ").trim(),
      date: String(r.date ?? ""),
      media: String(r.mediaName ?? "未署名"),
    })).filter((r) => r.title);
  } catch {
    return null;
  }
}

function queryDsa(codes, windowStart) {
  const out = new Map();
  if (!codes.size || !fs.existsSync(DSA_DB)) return out;
  const db = new DatabaseSync(DSA_DB);
  const ph = [...codes.keys()].map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT code, name, sentiment_score, operation_advice, trend_prediction,
              ideal_buy, secondary_buy, stop_loss, take_profit,
              analysis_summary, raw_result, created_at
       FROM analysis_history
       WHERE code IN (${ph}) AND created_at >= ?
       ORDER BY created_at`
    )
    .all(...codes.keys(), windowStart);
  db.close();
  for (const r of rows) {
    const code = String(r.code || "").trim();
    if (!/^\d{6}$/.test(code)) continue;
    // 全量提取：有什么取什么，缺字段留空不编
    let oneSentence = "", buyZone = "", targets = "", confidence = "";
    let signalType = "", posNoPos = "", posHasPos = "";
    let techSummary = "", bullPoints = [], bearPoints = [];
    let capflowStatus = "", capflowNotes = "";
    let riskWarning = "", scenarios = [], checklist = [];
    let fundamentals = "", quoteSummary = "", marketContext = "", chipNotes = "";
    let caveats = [], curPrice = "", changePct = "";
    let rawScore = null, clampReason = "";
    try {
      const raw = JSON.parse(r.raw_result || "{}");
      confidence = raw.confidence_level || "";
      riskWarning = String(raw.risk_warning || "").trim();
      const dash = raw.dashboard || {};
      // 风控钳制记录：结论被降级观望时 DSA 会把分数压进 45–59，原始分与原因存放在这里。
      // 排名按原始分（2026-10-21 Z 定），最终分只作标注，不参与排序。
      const calib = dash.decision_score_calibration || {};
      if (calib.raw_score !== null && calib.raw_score !== undefined && Number.isFinite(Number(calib.raw_score))) {
        rawScore = Number(calib.raw_score);
      }
      clampReason = String(calib.guardrail_reason || "").trim();
      const cc = dash.core_conclusion || {};
      oneSentence = String(cc.one_sentence || "").trim();
      // 去掉 emoji（PDF 中文字体不支持，会显示为方框）
      signalType = String(cc.signal_type || "").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu, "").trim();
      const pa = cc.position_advice || {};
      posNoPos = String(pa.no_position || "").trim();
      posHasPos = String(pa.has_position || "").trim();
      const sp = ((dash.battle_plan || {}).sniper_points) || {};
      buyZone = String(sp.buy_zone || "").trim();
      const t1 = String(sp.target_1 || "").trim();
      const t2 = String(sp.target_2 || "").trim();
      targets = [t1, t2].filter(Boolean).join("/");
      // 技术面
      const tech = dash.technical || {};
      const techBits = [];
      if (tech.trend_status) techBits.push(`趋势状态：${tech.trend_status}`);
      const ma = tech.ma || {};
      if (ma.ma5) techBits.push(`MA5 ${ma.ma5} / MA10 ${ma.ma10} / MA20 ${ma.ma20} / MA60 ${ma.ma60}`);
      if (tech.ma_alignment) techBits.push(tech.ma_alignment);
      const macd = tech.macd || {};
      if (macd.signal) techBits.push(`MACD：${macd.signal}`);
      const rsi = tech.rsi || {};
      if (rsi.signal) techBits.push(`RSI：${rsi.signal}`);
      const sr = tech.support_resistance || {};
      const sups = (sr.support_levels || []).filter(Boolean);
      const ress = (sr.resistance_levels || []).filter(Boolean);
      if (sups.length) techBits.push(`支撑：${sups.join("、")}`);
      if (ress.length) techBits.push(`阻力：${ress.join("、")}`);
      techSummary = techBits.join("；");
      // 多空论点
      const thesis = dash.thesis || {};
      bullPoints = (thesis.bull_cn || []).filter(Boolean).map(String);
      bearPoints = (thesis.bear_cn || []).filter(Boolean).map(String);
      // 资金面
      const cf = dash.capital_flow || {};
      capflowStatus = String(cf.status || "").trim();
      capflowNotes = String(cf.notes_cn || "").trim();
      // 情景与检查清单
      const sc = dash.scenarios || {};
      for (const k of ["bull", "base", "bear"]) {
        const s = sc[k];
        if (s) scenarios.push(`${k}: ${String(s.desc || s.text || s).slice(0, 120)}`);
      }
      const cl = dash.checklist || [];
      if (Array.isArray(cl)) {
        checklist = cl.slice(0, 8).map((c) => {
          if (typeof c === "string") return c;
          if (c && typeof c === "object") {
            const item = String(c.item_cn || c.item || c.text || "").trim();
            const st = String(c.status_cn || c.status || "").trim();
            return st ? `${item}（${st}）` : item;
          }
          return "";
        }).filter(Boolean);
      }
      // 基本面
      const fund = dash.fundamentals || {};
      const fundBits = [];
      const val = fund.valuation || {};
      if (val.pe_ttm) fundBits.push(`PE(TTM) ${val.pe_ttm}`);
      if (val.pb) fundBits.push(`PB ${val.pb}`);
      if (val.total_mv_cn) fundBits.push(`市值${val.total_mv_cn}`);
      if (val.notes_cn) fundBits.push(val.notes_cn);
      const gro = fund.growth || {};
      if (gro.notes_cn && gro.status !== "missing") fundBits.push(`成长：${gro.notes_cn}`);
      const ins = fund.institution || {};
      if (ins.notes_cn && ins.status !== "missing") fundBits.push(`机构：${ins.notes_cn}`);
      fundamentals = fundBits.join("；");
      // 行情快照
      const q = dash.quote || {};
      if (q.price) {
        const qb = [`现价 ${q.price}`];
        if (q.change_pct !== undefined) qb.push(`${q.change_pct >= 0 ? "+" : ""}${q.change_pct}%`);
        if (q.open) qb.push(`开 ${q.open} / 高 ${q.high} / 低 ${q.low}`);
        if (q.turnover_rate) qb.push(`换手 ${q.turnover_rate}%`);
        if (q.amplitude) qb.push(`振幅 ${q.amplitude}%`);
        quoteSummary = qb.join("，");
        curPrice = String(q.price);
        changePct = String(q.change_pct);
      }
      // 市场环境
      const mc = dash.market_context || {};
      const mcBits = [];
      if (mc.market_summary_cn) mcBits.push(mc.market_summary_cn);
      if (mc.risk_level) mcBits.push(`风险等级：${mc.risk_level}`);
      marketContext = mcBits.join("；");
      // 筹码分布
      const chip = dash.chip_distribution || {};
      if (chip.notes_cn) chipNotes = chip.notes_cn;
      // 注意事项
      const cv = dash.caveats_cn || [];
      if (Array.isArray(cv)) caveats = cv.filter(Boolean).map(String).slice(0, 6);
    } catch { /* 忽略解析失败 */ }
    out.set(code, { ...r, oneSentence, buyZone, targets, confidence,
      signalType, posNoPos, posHasPos, techSummary, bullPoints, bearPoints,
      capflowStatus, capflowNotes, riskWarning, scenarios, checklist,
      fundamentals, quoteSummary, marketContext, chipNotes, caveats,
      curPrice, changePct, rawScore, clampReason,
      rankScore: rawScore !== null ? rawScore : (r.sentiment_score ?? null) });
  }
  return out;
}

const fmtNum = (v) => {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  // 保留两位小数，去掉浮点误差（如 11.296000000000001 → 11.30）
  return n.toFixed(2);
};

function loadFont(candidates) {
  // .ttc 是字体集合：显式取出 SC（简体中文）子字体，避免 pdfkit 拿整个集合去 subset 失败
  for (const p of candidates) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      const buf = fs.readFileSync(p);
      const coll = fontkit.create(buf);
      const fonts = coll.fonts || [coll];
      const sc = fonts.find((f) => /SC\b/i.test(f.fullName || "")) || fonts[0];
      return sc;
    } catch { /* try next */ }
  }
  return null;
}

function buildPdf({ decisionDate, picks, analyzed, incomplete, top3, tied, pdfPath, generatedAt, trendMap }) {
  const regular = loadFont(FONT_CANDIDATES);
  if (!regular) throw new Error("找不到中文字体，PDF 无法生成（已按日报口径查找 NotoSansCJK）");
  const bold = loadFont(FONT_BOLD_CANDIDATES) || regular;

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 42, bottom: 50, left: 42, right: 42 },
    bufferPages: true,
    info: { Title: "DSA深挖报告", Author: "MyDesk" },
  });
  doc.registerFont("CJK", regular);
  doc.registerFont("CJKB", bold);
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  const W = 595.28, H = 841.89, MX = 42, MB = 50;
  const CW = W - MX * 2;
  const NAVY = "#1F3A5F";

  const need = (h) => { if (doc.y + h > H - MB) doc.addPage(); };
  const para = (text, { size = 10.5, font = "CJK", gap = 6, color = "#000000" } = {}) => {
    need(size * 2.2);
    doc.font(font).fontSize(size).fillColor(color).text(text, { width: CW, align: "left" });
    doc.moveDown(gap / 12);
  };
  const h1 = (text) => {
    need(40);
    doc.moveDown(0.6);
    doc.font("CJKB").fontSize(14).fillColor(NAVY).text(text, { width: CW });
    doc.moveDown(0.3);
    doc.strokeColor("#DDDDDD").lineWidth(0.5)
      .moveTo(MX, doc.y).lineTo(MX + CW, doc.y).stroke();
    doc.moveDown(0.4);
  };

  // 重点行（同日报 key 块）：浅底色 + 左侧藏青竖线 + 加粗深蓝字，整块不跨页截断
  const keyBox = (text) => {
    const size = 10, padX = 10, padY = 6;
    const h = doc.font("CJKB").fontSize(size).heightOfString(text, { width: CW - padX * 2 }) + padY * 2;
    need(h + 6);
    const y = doc.y;
    doc.rect(MX, y, CW, h).fill("#EEF2F8");
    doc.rect(MX, y, 3, h).fill(NAVY);
    doc.font("CJKB").fontSize(size).fillColor(NAVY)
      .text(text, MX + padX, y + padY, { width: CW - padX * 2 });
    doc.y = y + h;
    doc.x = MX;
    doc.moveDown(0.5);
  };
  // 话题隔断（同日报 divider 块）：浅灰横线 + 上下留白
  const divider = () => {
    need(26);
    doc.moveDown(0.7);
    doc.strokeColor("#D9DEE7").lineWidth(0.8)
      .moveTo(MX, doc.y).lineTo(MX + CW, doc.y).stroke();
    doc.moveDown(0.7);
    doc.x = MX;
  };
  // 两列信息表（项目/内容）：左侧项目列浅灰底，逐行描边
  const infoTable = (rows) => {
    if (!rows.length) return;
    const lw = 76;
    for (const [label, value] of rows) {
      const h = Math.max(
        doc.font("CJK").fontSize(9.5).heightOfString(String(label), { width: lw - 8 }),
        doc.font("CJK").fontSize(9.5).heightOfString(String(value), { width: CW - lw - 8 })
      ) + 8;
      need(h + 2);
      const y = doc.y;
      doc.rect(MX, y, lw, h).fill("#F5F7FA");
      doc.rect(MX, y, CW, h).stroke("#999999");
      doc.font("CJKB").fontSize(9.5).fillColor("#000000").text(String(label), MX + 4, y + 4, { width: lw - 8 });
      doc.font("CJK").fontSize(9.5).fillColor("#000000").text(String(value), MX + lw + 4, y + 4, { width: CW - lw - 8 });
      doc.y = y + h;
      doc.x = MX;
    }
    doc.moveDown(0.5);
  };

  // 资金流小表（日期/方向/主力净额）：藏青表头 + 斑马纹，末行给近N日合计
  const flowTable = (flow) => {
    if (!flow || !flow.length) return;
    const widths = [120, 120, CW - 240];
    const headers = ["日期", "主力方向", "主力净额（亿元）"];
    const drawFlowRow = (cells, isHeader, zebra, boldAll = false) => {
      const h = Math.max(...cells.map((t, i) =>
        doc.font(isHeader || boldAll ? "CJKB" : "CJK").fontSize(9.5)
          .heightOfString(String(t), { width: widths[i] - 8 }))) + 9;
      need(h + 2);
      let x = MX;
      const y = doc.y;
      if (isHeader || zebra) doc.rect(MX, y, CW, h).fill(isHeader ? NAVY : "#F5F7FA");
      doc.rect(MX, y, CW, h).stroke("#999999");
      cells.forEach((t, i) => {
        doc.font(isHeader || boldAll ? "CJKB" : "CJK").fontSize(9.5)
          .fillColor(isHeader ? "#FFFFFF" : "#000000")
          .text(String(t), x + 4, y + 4.5, { width: widths[i] - 8 });
        x += widths[i];
      });
      doc.y = y + h;
      doc.x = MX;
    };
    const signed = (v) => (v > 0 ? "+" : v < 0 ? "-" : "") + Math.abs(v).toFixed(2);
    drawFlowRow(headers, true, false);
    flow.forEach((d, i) => {
      const dir = d.netYi > 0 ? "净流入" : d.netYi < 0 ? "净流出" : "持平";
      drawFlowRow([d.date, dir, signed(d.netYi)], false, i % 2 === 1);
    });
    const total = flow.reduce((s, d) => s + d.netYi, 0);
    const tDir = total > 0 ? "合计净流入" : total < 0 ? "合计净流出" : "合计持平";
    drawFlowRow([`近${flow.length}日合计`, tDir, signed(total)], false, false, true);
    doc.moveDown(0.5);
  };

  // 标题区：头像置顶（同日报版式：圆形裁切、居中 96×96）；标题只叫《DSA深挖报告》
  // （2026-10-21 Z 定：去掉 MyDesk；头像此前漏加，本次补上）
  const AVATAR_PNG = path.join(REPO, "scripts/avatar-lulu-cover.png");
  if (fs.existsSync(AVATAR_PNG)) {
    const AV_SIZE = 96;
    const avX = MX + (CW - AV_SIZE) / 2;
    const avY = doc.y;
    doc.save();
    doc.circle(avX + AV_SIZE / 2, avY + AV_SIZE / 2, AV_SIZE / 2).clip();
    doc.image(AVATAR_PNG, avX, avY, { width: AV_SIZE, height: AV_SIZE });
    doc.restore();
    doc.y = avY + AV_SIZE + 14;
    doc.x = MX;
  }
  doc.font("CJKB").fontSize(20).fillColor("#000000")
    .text("DSA深挖报告", MX, doc.y, { width: CW, align: "center" });
  doc.moveDown(0.5);
  doc.font("CJK").fontSize(9).fillColor("#555555")
    .text(`AI 优选决策日：${decisionDate}　报告生成：${generatedAt}（北京时间）`, { width: CW, align: "center" });
  doc.moveDown(0.3);
  doc.font("CJK").fontSize(9).fillColor("#555555").text(
    "说明：本批为当日 AI 优选选出的股票，DSA（缠论+情绪周期+事件驱动）逐只深挖后按评分挑出最值得看的三只。评分是 DSA 模型的打分，仅供参考，不构成买卖建议。",
    { width: CW });
  doc.moveDown(0.3);
  doc.font("CJK").fontSize(9).fillColor("#555555").text(
    "排名按模型原始评分；个别票的最终分会被 DSA 风控压低（结论降级观望时压进 45–59），这类票在正文单独标明原始分和压分原因。",
    { width: CW });
  doc.moveDown(0.8);

  // 一、挑出的三只
  h1("一、DSA 挑出的三只");
  if (top3.length) {
    const names = top3.map(([c, a]) => `${c} ${picks.get(c) || ""}（${a.rankScore}分${a.rawScore !== null && a.rawScore !== undefined ? "，原始分" : ""}）`).join("、");
    para(`按 DSA 模型原始评分由高到低：${names}。${tied ? "（第 3 名有并列，一并列出）" : ""}`);
    let stockIdx = 0;
    for (const [c, a] of top3) {
      if (stockIdx > 0) divider();
      stockIdx++;
      need(60);
      doc.font("CJKB").fontSize(12.5).fillColor(NAVY)
        .text(`${c} ${picks.get(c) || ""} —— 评分 ${a.rankScore}`, { width: CW });
      doc.moveDown(0.2);
      if (a.rawScore !== null && a.rawScore !== undefined
          && a.sentiment_score !== null && a.sentiment_score !== undefined
          && a.rawScore !== a.sentiment_score) {
        para(`评分说明：上面是模型原始分 ${a.rawScore}。DSA 风控把这只票的最终分压到了 ${a.sentiment_score}${a.clampReason ? `（原因：${a.clampReason}）` : ""}，本报告按原始分排名——最终分低是被压的，不代表模型不看好。`);
      }
      const infoRows = [];
      if (a.operation_advice) infoRows.push(["操作建议", a.operation_advice]);
      if (a.trend_prediction) infoRows.push(["趋势", a.trend_prediction]);
      if (a.confidence) infoRows.push(["信心", a.confidence]);
      if (a.signalType) infoRows.push(["信号", a.signalType]);
      if (a.buyZone) infoRows.push(["买入区", a.buyZone]);
      if (fmtNum(a.stop_loss)) infoRows.push(["止损", fmtNum(a.stop_loss)]);
      if (a.targets) infoRows.push(["目标", a.targets]);
      infoTable(infoRows);
      if (a.oneSentence) {
        let os = a.oneSentence;
        // DSA 分析时（15:35）资金流缺失，但报告生成时已补上新浪资金流，加注说明避免矛盾
        if (a.sinaFlow && a.sinaFlow.length && /资金流数据缺失|缺少资金面/.test(os)) {
          os += "（注：DSA 分析时资金流未取到，本报告下方「资金面（新浪口径）」已补上当日数据。）";
        }
        keyBox("一句话：" + os);
      }
      if (a.quoteSummary) para("行情：" + a.quoteSummary + "。");
      if (trendMap && trendMap.has(c)) para(trendLine(trendMap.get(c)));
      if (a.techSummary) {
        let tech = a.techSummary;
        tech = tech.replace(/MA5/g, "5日均线").replace(/MA10/g, "10日均线")
                   .replace(/MA20/g, "20日均线").replace(/MA60/g, "60日均线");
        tech = tech.replace(/DIF上穿零轴/g, "短期趋势转强");
        tech = tech.replace(/多头排列/g, "均线多头排列（短期涨得比长期快，是好事）");
        tech = tech.replace(/弱势多头/g, "趋势偏弱但还在涨");
        tech = tech.replace(/弱势空头/g, "趋势偏弱在跌");
        para("技术面：" + tech + "。");
      }
      if (a.fundamentals) para("基本面：" + a.fundamentals + "。");
      // 腾讯实时基本面补充（小白话）
      if (a.txFund) {
        const tf = a.txFund;
        const bits = [];
        if (tf.pe_ttm) {
          const peDesc = tf.pe_ttm > 50 ? "很贵" : tf.pe_ttm > 30 ? "偏贵" : tf.pe_ttm > 15 ? "还行" : "便宜";
          bits.push(`市盈率${tf.pe_ttm}倍（${peDesc}）`);
        }
        if (tf.pb) bits.push(`市净率${tf.pb}倍`);
        if (tf.mkt_cap_yi) bits.push(`公司值${tf.mkt_cap_yi}亿元`);
        if (tf.turnover_pct) bits.push(`换手${tf.turnover_pct}%`);
        if (bits.length) para(`基本面：${bits.join("，")}。`);
      }
      if (a.chipNotes) para("筹码（DSA）：" + a.chipNotes);
      // 本地计算的筹码分布（小白话）
      if (a.chipCalc) {
        const cc = a.chipCalc;
        const bits = [
          `100人里有${cc.profit_ratio}个赚钱`,
          `大家平均买在${cc.avg_cost}元`,
          `最多人买在${cc.peak_price}元附近`,
        ];
        para(`筹码：${bits.join("，")}。`);
      }
      if (a.bullPoints.length) {
        para("看多理由：", { font: "CJKB" });
        a.bullPoints.forEach((b, i) => para(`${i + 1}. ${b}`, { size: 10 }));
      }
      if (a.bearPoints.length) {
        para("看空理由：", { font: "CJKB" });
        a.bearPoints.forEach((b, i) => para(`${i + 1}. ${b}`, { size: 10 }));
      }
      if (a.capflowNotes) {
        para(`资金面（DSA）：${a.capflowNotes}`);
      } else if (a.capflowStatus && a.capflowStatus !== "ok") {
        para(`资金面（DSA）：数据缺失（${a.capflowStatus}），未做资金面推断。`);
      }
      // MyDesk 新浪资金流：近5日逐日表格（同日报口径：数据密集内容表格化）
      if (a.sinaFlow && a.sinaFlow.length) {
        para("资金面（新浪口径）：", { font: "CJKB" });
        flowTable(a.sinaFlow);
        const latest = a.sinaFlow[a.sinaFlow.length - 1];
        const dir = latest.netYi > 0 ? "主力净流入" : latest.netYi < 0 ? "主力净流出" : "主力资金持平";
        para(`最新 ${latest.date}：${dir} ${Math.abs(latest.netYi).toFixed(2)} 亿元。`);
      } else {
        para("资金面（新浪口径）：未取到数据。");
      }
      if (a.posNoPos || a.posHasPos) {
        if (a.posNoPos) para(`空仓怎么办：${a.posNoPos}`);
        if (a.posHasPos) para(`持仓怎么办：${a.posHasPos}`);
      }
      if (a.riskWarning && a.riskWarning !== a.oneSentence) keyBox(`风险提示：${a.riskWarning}`);
      if (a.scenarios.length) {
        para("情景：", { font: "CJKB" });
        a.scenarios.forEach((s) => para(`· ${s}`, { size: 10 }));
      }
      if (a.checklist.length) {
        para("检查清单：", { font: "CJKB" });
        a.checklist.forEach((ch) => para(`· ${ch}`, { size: 10 }));
      }
      if (a.marketContext) para(`市场环境：${a.marketContext}`);
      // 新闻面（东财个股新闻）：日期一行，新闻在下面（日报格式）
      if (a.emNews && a.emNews.length) {
        para(`新闻面（东财，${a.emNews.length}条）：`, { font: "CJKB" });
        // 按日期分组
        const byDate = new Map();
        for (const n of a.emNews) {
          const d = (n.date || "").slice(0, 10) || "未知日期";
          if (!byDate.has(d)) byDate.set(d, []);
          byDate.get(d).push(n);
        }
        for (const [d, items] of byDate) {
          para(d, { size: 10, color: "#555555" });
          items.forEach((n) => para(`· ${n.title}（${n.media}）`, { size: 10 }));
        }
      } else {
        para("新闻面（东财）：未取到该股相关新闻。");
      }
      if (a.caveats.length) {
        para("注意事项：", { font: "CJKB" });
        a.caveats.forEach((cv) => para(`· ${cv}`, { size: 10 }));
      }
      doc.moveDown(0.3);
    }
  } else {
    para("本批暂无完成分析的股票，未挑出。");
  }

  // 二、本批全部（按评分从高到低排序）
  h1("二、本批全部分析结果");
  const headers = ["代码", "名称", "评分", "操作建议", "趋势", "趋势阶段", "止损"];
  const widths = [56, 84, 40, 88, 84, 86, CW - 56 - 84 - 40 - 88 - 84 - 86];
  const rows = [...picks.keys()]
    .map((c) => {
      const a = analyzed.get(c);
      const score = a && a.rankScore !== null && a.rankScore !== undefined ? a.rankScore : -1;
      return { c, a, score };
    })
    .sort((x, y) => y.score - x.score)
    .map(({ c, a }) => {
      if (a) {
        const clamped = a.rawScore !== null && a.rawScore !== undefined
          && a.sentiment_score !== null && a.sentiment_score !== undefined
          && a.rawScore !== a.sentiment_score;
        const scoreCell = a.rankScore !== null && a.rankScore !== undefined
          ? `${a.rankScore}${clamped ? " *" : ""}` : "";
        const tl = trendMap && trendMap.has(c) ? trendShortLabel(trendMap.get(c)) : "";
        return [c, picks.get(c) || "", scoreCell, a.operation_advice || "", a.trend_prediction || "", tl, fmtNum(a.stop_loss)];
      }
      const tl2 = trendMap && trendMap.has(c) ? trendShortLabel(trendMap.get(c)) : "";
      return [c, picks.get(c) || "", "未完成", "", "", tl2, ""];
    });
  const drawRow = (cells, isHeader, zebra) => {
    const h = Math.max(...cells.map((t, i) =>
      doc.heightOfString(String(t), { width: widths[i] - 8 }))) + 10;
    need(h + 2);
    let x = MX;
    const y = doc.y;
    if (isHeader || zebra) {
      doc.rect(MX, y, CW, h).fill(isHeader ? NAVY : "#F5F7FA");
    }
    doc.rect(MX, y, CW, h).stroke("#999999");
    cells.forEach((t, i) => {
      doc.font(isHeader ? "CJKB" : "CJK").fontSize(9)
        .fillColor(isHeader ? "#FFFFFF" : "#000000")
        .text(String(t), x + 4, y + 5, { width: widths[i] - 8 });
      x += widths[i];
    });
    doc.y = y + h;
  };
  drawRow(headers, true, false);
  rows.forEach((r, i) => drawRow(r, false, i % 2 === 1));
  doc.x = MX; // 表格逐格 text() 会把 doc.x 留在最后一格，后续段落须回到左边距（否则注脚/页脚被右推裁切）
  doc.moveDown(0.6);
  const clampedList = [...analyzed.entries()]
    .filter(([, a]) => a.rawScore !== null && a.rawScore !== undefined
      && a.sentiment_score !== null && a.sentiment_score !== undefined
      && a.rawScore !== a.sentiment_score)
    .sort((x, y) => y[1].rawScore - x[1].rawScore);
  if (clampedList.length) {
    para("注：评分带 * 的是模型原始分，以下票的最终分被 DSA 风控压低过，本报告按原始分排名："
      + clampedList.map(([c, a]) => `${c} ${picks.get(c) || ""}（原始 ${a.rawScore} → 最终 ${a.sentiment_score}${a.clampReason ? `，原因：${a.clampReason}` : ""}）`).join("；")
      + "。");
  }

  if (incomplete.length) {
    h1("三、分析未完成的股票");
    para(`以下 ${incomplete.length} 只分析未完成（DSA 未产出结果），本报告不对其下任何结论：` +
      incomplete.map((c) => `${c} ${picks.get(c) || ""}`).join("、") + "。");
  }

  doc.moveDown(0.8);
  doc.font("CJK").fontSize(9).fillColor("#555555")
    .text("数据口径：DSA 分析结论来自其 LLM 分析流水线；缺失字段留空，未编造。趋势阶段由 MyDesk 按决策日收盘的日K与周线结构本地判定（方向：上升/下跌/震荡；阶段：趋势健康/趋势内回撤/顶部形成中/趋势反转/下行延续），只标注，不影响选股与评分。", { width: CW });

  doc.end();
  return new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

async function main() {
  const now = shanghaiNow();
  const todayStr = fmtDate(now);
  const yesterdayStr = fmtDate(addDays(now, -1));
  const argDate = process.argv[2];
  const decisionDate = argDate || latestDecisionDate(yesterdayStr);
  if (!decisionDate) {
    console.log("RESULT=NO_VERSION");
    return;
  }
  // 非交易日静默跳过（cron 层也做，这里是第二道；手动指定日期时不跳过）
  if (!argDate && !isTradingDay(todayStr)) {
    console.log("RESULT=SKIP_NON_TRADING");
    return;
  }
  const picks = loadPicks(decisionDate);
  if (!picks.size) {
    console.log(`RESULT=NO_PICKS decision_date=${decisionDate}`);
    return;
  }
  // 趋势阶段（MyDesk 本地判定，按决策日收盘，只标注）：全部优选股逐只算，并落台账攒评审样本
  const trendMap = new Map();
  try {
    const deskDb = new DatabaseSync(DESK_DB, { readOnly: true });
    for (const c of picks.keys()) {
      const sym = symbolOf(c);
      const bars = sym ? loadBars(deskDb, sym, decisionDate) : [];
      trendMap.set(c, computeTrendStage(bars));
    }
    deskDb.close();
    console.log(`TREND_STAGES=${[...trendMap.entries()].map(([c, t]) => `${c}:${trendShortLabel(t)}`).join(",")}`);
    try {
      let seen = new Set();
      if (fs.existsSync(TREND_LEDGER)) {
        for (const line of fs.readFileSync(TREND_LEDGER, "utf-8").split("\n")) {
          if (!line.trim()) continue;
          try { const j = JSON.parse(line); seen.add(`${j.decisionDate}|${j.code}`); } catch { /* ignore */ }
        }
      }
      const add = [];
      for (const [c, t] of trendMap.entries()) {
        if (!t || seen.has(`${decisionDate}|${c}`)) continue;
        add.push(JSON.stringify({
          decisionDate, code: c, name: picks.get(c) || "",
          direction: t.direction, stage: t.stage, close: t.close,
          dayChg: t.dayChg, chg20: t.chg20, chg60: t.chg60,
          distMA60: t.distMA60, distHigh20: t.distHigh20, distHigh250: t.distHigh250,
          maStruct: t.maStruct, volRatio: t.volRatio, chg5: t.chg5, asOf: t.asOf,
        }));
      }
      if (add.length) fs.appendFileSync(TREND_LEDGER, add.join("\n") + "\n");
      console.log(`TREND_LEDGER_ADDED=${add.length}`);
    } catch (e) {
      console.log(`TREND_LEDGER_FAILED=${e.message.slice(0, 100)}`);
    }
  } catch (e) {
    console.log(`TREND_FAILED=${e.message.slice(0, 100)}`);
  }

  const analyzed = queryDsa(picks, `${decisionDate} 15:00:00`);
  const incomplete = [...picks.keys()].filter((c) => !analyzed.has(c));

  // 抓新浪资金流（MyDesk 同款源）：每只取近 5 日，并行抓
  const flowMap = new Map();
  await Promise.all([...analyzed.keys()].map(async (c) => {
    const flow = await fetchSinaFundFlow(c, 5);
    if (flow) flowMap.set(c, flow);
  }));
  for (const [c, a] of analyzed.entries()) {
    a.sinaFlow = flowMap.get(c) || null;
  }

  // 抓东财个股新闻（MyDesk 同款源）：按股票名搜，并行抓，失败重试一次
  const newsMap = new Map();
  await Promise.all([...analyzed.keys()].map(async (c) => {
    let stockName = picks.get(c) || "";
    // 去掉 XD/XR/DR 除权除息前缀，否则搜不到新闻
    stockName = stockName.replace(/^(XD|XR|DR)/, "");
    if (!stockName) return;
    let news = await fetchEmStockNews(stockName, 5);
    if (!news || !news.length) {
      await new Promise((r) => setTimeout(r, 2000));
      news = await fetchEmStockNews(stockName, 5);
    }
    if (news && news.length > 0) newsMap.set(c, news);
    else console.log(`EM_NEWS_EMPTY=${c} ${stockName}`);
  }));
  for (const [c, a] of analyzed.entries()) {
    a.emNews = newsMap.get(c) || null;
  }
  console.log(`EM_NEWS_FETCHED=${newsMap.size}/${analyzed.size} stocks have news`);

  // 抓基本面（腾讯实时 via 隧道代理）：PE/PB/换手率/市值
  const fundMap = new Map();
  try {
    const codes = [...analyzed.keys()].join(" ");
    const { execSync } = await import("node:child_process");
    const out = execSync(
      `python3 ${path.join(REPO, "scripts/fundamentals.py")} ${codes}`,
      { encoding: "utf-8", timeout: 60000, maxBuffer: 1024 * 1024 }
    );
    const fj = JSON.parse(out);
    for (const [c, v] of Object.entries(fj)) {
      if (v && !v.error) fundMap.set(c, v);
    }
    console.log(`FUNDAMENTALS_FETCHED=${fundMap.size}/${analyzed.size}`);
  } catch (e) {
    console.log(`FUNDAMENTALS_FAILED=${e.message.slice(0, 100)}`);
  }
  for (const [c, a] of analyzed.entries()) {
    a.txFund = fundMap.get(c) || null;
  }

  // 抓筹码分布（新浪日K + 腾讯股本 → 历史换手率 → 本地计算）
  const chipMap = new Map();
  try {
    const codes = [...analyzed.keys()].join(" ");
    const { execSync } = await import("node:child_process");
    const out = execSync(
      `python3 ${path.join(REPO, "scripts/chip-history.py")} ${codes}`,
      { encoding: "utf-8", timeout: 120000, maxBuffer: 1024 * 1024 }
    );
    const cj = JSON.parse(out);
    for (const [c, v] of Object.entries(cj)) {
      if (v && v.chip && !v.error) chipMap.set(c, v.chip);
    }
    console.log(`CHIP_FETCHED=${chipMap.size}/${analyzed.size}`);
  } catch (e) {
    console.log(`CHIP_FAILED=${e.message.slice(0, 100)}`);
  }
  for (const [c, a] of analyzed.entries()) {
    a.chipCalc = chipMap.get(c) || null;
  }

  const ranked = [...analyzed.entries()]
    .filter(([, a]) => a.rankScore !== null && a.rankScore !== undefined)
    .sort((a, b) => b[1].rankScore - a[1].rankScore);
  const top3 = [];
  for (const [c, a] of ranked) {
    if (top3.length < 3) top3.push([c, a]);
    else if (a.rankScore === top3[top3.length - 1][1].rankScore) top3.push([c, a]);
    else break;
  }
  const tied = top3.length > 3;

  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.mkdirSync(YOUR_FILES, { recursive: true });
  const pdfName = `DSA深挖报告-${decisionDate}.pdf`;
  const pdfPath = path.join(FILES_DIR, pdfName);
  const generatedAt = `${todayStr} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  await buildPdf({ decisionDate, picks, analyzed, incomplete, top3, tied, pdfPath, generatedAt, trendMap });

  const link = path.join(YOUR_FILES, pdfName);
  try { if (fs.existsSync(link) || fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch { /* ignore */ }
  fs.symlinkSync(path.relative(YOUR_FILES, pdfPath), link);

  console.log(`RESULT=OK decision_date=${decisionDate}`);
  console.log(`PICKS=${picks.size} ANALYZED=${analyzed.size} INCOMPLETE=${incomplete.length}`);
  console.log(`TOP3=${top3.map(([c, a]) => `${c}:${a.rankScore}`).join(",")} TIED=${tied ? 1 : 0}`);
  if (incomplete.length) console.log(`INCOMPLETE_CODES=${incomplete.join(",")}`);
  console.log(`PDF=${pdfPath}`);
}

main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
