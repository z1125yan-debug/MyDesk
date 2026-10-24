// 日报 PDF · 拉取 + 渲染层（带 IO）。
//
// 接口：GET /api/daily-report/pdf?slot=morning|noon|evening|weekly&date=YYYY-MM-DD
//   → 直接返回 PDF 文件（Content-Type: application/pdf）。
//
// 渲染：PDFKit + 系统中文字体（Noto Sans CJK SC / 苹方 / 微软雅黑，
//   TTC 集合字体在内存里抽成单个 TTF 再交给 PDFKit；不在仓库里放字体文件）。
//   中文字体找不到时抛 DailyPdfFontError（调用方返回 502 说明），绝不拿
//   内置西文字体硬画中文（会乱码）。
//
// UI（第一版，用户已定）：封面 = 噜噜头像（圆形裁切）+ “MyDesk 日报”
//   + 日期·时段一行；不放副标题、不放生成时间/数据来源元信息行、不放目录。
//   元信息（签发日/数据归属/生成时刻）不放正文；附录已按用户要求去掉（2026-10-17），不再渲染。
//   分页：表格整表原子 + AI 卡整卡原子 + 页脚手动居中（不传 width/align）。
//
// 数据：与日报正文同源（同花顺行业榜 / 巨潮 / 涨停梯队 / 已落库 AI 优选 /
//   长桥美股 / Kalshi + Polymarket），当天生成时现拉结构化数据；
//   历史日期只有落档正文，就只画落档正文，不拿今天的数据冒充当天的。

import { promises as fs } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { db } from "@/lib/db";
import { shanghaiDate } from "@/lib/desk/session";
import { fetchDailyReportBySector } from "@/lib/desk/daily-report-by-sector";
import { fetchDailyReductionRisk } from "@/lib/desk/daily-report-sections";
import { fetchThreeDailyReport, readStoredReport } from "@/lib/desk/three-daily-reports";
import { pickDivergenceHighlights, pickLimitUpLeaders, type ReportSlot } from "@/lib/desk/three-daily-reports-core";
import { fetchWeeklyReport, loadArchivedWeeklyReport } from "@/lib/desk/weekly-report";
import { addDays, weekRangeOf } from "@/lib/desk/weekly-report-core";
import { computeLimitUp } from "@/lib/quant/screener/limitup";
import { AI_PICK_CARD_FIELDS, parseAiPickNote, stripPickDayChangePct } from "@/lib/quant/strategy/ai-pick-note";
import {
  AI_PICK_MISSING,
  buildDailyPdfModel,
  buildStoredTextPdfModel,
  buildWeeklyPdfModel,
  cleanCell,
  stripEmoji,
  type PdfAiCard,
  type PdfDocModel,
  type PdfTable,
  type PdfBars,
} from "@/lib/desk/daily-report-pdf-core";

export class DailyPdfNotFoundError extends Error {}
export class DailyPdfFontError extends Error {}

// ── 中文字体：系统字体文件 → Buffer ──

const REGULAR_CANDIDATES = [
  process.env.PDF_CJK_FONT ?? "",
  process.env.PDF_CJK_FONT_REGULAR ?? "",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/Library/Fonts/PingFang.ttc",
  "C:\\Windows\\Fonts\\msyh.ttc",
  "C:\\Windows\\Fonts\\simsun.ttc",
  "C:\\Windows\\Fonts\\simhei.ttf",
].filter(Boolean);

const BOLD_CANDIDATES = [
  process.env.PDF_CJK_FONT_BOLD ?? "",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/Library/Fonts/PingFang.ttc",
  "C:\\Windows\\Fonts\\msyhbd.ttc",
  "C:\\Windows\\Fonts\\simhei.ttf",
].filter(Boolean);

function decodeNameString(buf: Buffer, platform: number): string {
  if (platform === 3 || platform === 0) {
    // UTF-16BE
    const swapped = Buffer.alloc(buf.length);
    for (let i = 0; i + 1 < buf.length; i += 2) {
      swapped[i] = buf[i + 1];
      swapped[i + 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }
  return buf.toString("latin1");
}

/** TTC 里每个字体的 PostScript 名（nameID=6）；解析不出时返回 null（调用方降级） */
function ttcPostscriptNames(ttc: Buffer): (string | null)[] {
  try {
    if (ttc.toString("ascii", 0, 4) !== "ttcf") return [];
    const num = ttc.readUInt32BE(8);
    const names: (string | null)[] = [];
    for (let i = 0; i < num; i++) {
      const off = ttc.readUInt32BE(12 + i * 4);
      const numTables = ttc.readUInt16BE(off + 4);
      let nameOff = -1;
      let nameLen = 0;
      for (let t = 0; t < numTables; t++) {
        const r = off + 12 + t * 16;
        if (ttc.toString("ascii", r, r + 4) === "name") {
          nameOff = ttc.readUInt32BE(r + 8);
          nameLen = ttc.readUInt32BE(r + 12);
          break;
        }
      }
      if (nameOff < 0) {
        names.push(null);
        continue;
      }
      const count = ttc.readUInt16BE(nameOff + 2);
      const stringOff = ttc.readUInt16BE(nameOff + 4);
      let ps: string | null = null;
      for (let n = 0; n < count; n++) {
        const rec = nameOff + 6 + n * 12;
        const platform = ttc.readUInt16BE(rec);
        const nameId = ttc.readUInt16BE(rec + 6);
        if (nameId !== 6) continue;
        const len = ttc.readUInt16BE(rec + 8);
        const strOff = ttc.readUInt16BE(rec + 10);
        const start = nameOff + stringOff + strOff;
        if (start + len > nameOff + nameLen) continue;
        const s = decodeNameString(ttc.subarray(start, start + len), platform);
        if (s) {
          ps = s;
          break;
        }
      }
      names.push(ps);
    }
    return names;
  } catch {
    return [];
  }
}

function scoreFontName(name: string | null, wantBold: boolean): number {
  if (!name) return -50;
  if (/mono/i.test(name)) return -100;
  let score = 0;
  if (/CJKsc|PingFangSC|MicrosoftYaHei|YaHei|STHeiti|DengXian|SimSun|FandolSong|Song|Hei/i.test(name)) score += 10;
  if (/CJKjp|CJKkr|CJKtc|CJKHk|PingFangHK|PingFangTC/i.test(name) && !/CJKsc|PingFangSC/i.test(name)) score -= 8;
  if (wantBold) {
    if (/bold|heavy|black|semibold|demibold/i.test(name)) score += 20;
    else if (/regular|medium|light/i.test(name)) score -= 5;
  } else {
    if (/regular/i.test(name)) score += 10;
    else if (/medium/i.test(name)) score += 5;
    else if (/bold|black|heavy/i.test(name)) score -= 10;
    else if (/light|thin/i.test(name)) score -= 5;
  }
  return score;
}

/** 从 TTC 集合里抽出第 index 个字体，重建成单个 TTF（表数据原样搬运，校验和重算）。 */
export function extractTtfFromTtc(ttc: Buffer, index: number): Buffer {
  const num = ttc.readUInt32BE(8);
  if (index < 0 || index >= num) throw new Error(`TTC 字体序号越界：${index}/${num}`);
  const off = ttc.readUInt32BE(12 + index * 4);
  const sfntVersion = ttc.readUInt32BE(off);
  const numTables = ttc.readUInt16BE(off + 4);
  const records: { tag: string; offset: number; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const r = off + 12 + i * 16;
    records.push({
      tag: ttc.toString("ascii", r, r + 4),
      offset: ttc.readUInt32BE(r + 8),
      length: ttc.readUInt32BE(r + 12),
    });
  }
  records.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const headerLen = 12 + numTables * 16;
  let dataOff = headerLen;
  const placed = records.map((rec) => {
    const newOffset = dataOff;
    dataOff += Math.ceil(rec.length / 4) * 4;
    return { ...rec, newOffset };
  });
  const out = Buffer.alloc(dataOff);
  out.writeUInt32BE(sfntVersion, 0);
  out.writeUInt16BE(numTables, 4);
  const pow2 = Math.pow(2, Math.floor(Math.log2(Math.max(1, numTables))));
  out.writeUInt16BE(16 * pow2, 6);
  out.writeUInt16BE(Math.log2(pow2), 8);
  out.writeUInt16BE(numTables * 16 - 16 * pow2, 10);
  let p = 12;
  for (const rec of placed) {
    out.write(rec.tag, p, "ascii");
    p += 4;
    out.writeUInt32BE(0, p); // 校验和占位，PDFKit 不校验；子集化不走原始字节
    p += 4;
    out.writeUInt32BE(rec.newOffset, p);
    p += 4;
    out.writeUInt32BE(rec.length, p);
    p += 4;
  }
  for (const rec of placed) {
    ttc.copy(out, rec.newOffset, rec.offset, rec.offset + rec.length);
  }
  // head.checkSumAdjustment：置 0 再按全字体校验和反推（标准做法）
  const head = placed.find((r) => r.tag === "head");
  if (head) {
    out.writeUInt32BE(0, head.newOffset + 8);
    let total = 0;
    for (let i = 0; i < out.length; i += 4) {
      let v = 0;
      for (let j = 0; j < 4; j++) v = (v << 8) | (i + j < out.length ? out[i + j] : 0);
      total = (total + v) >>> 0;
    }
    out.writeUInt32BE((0xb1b0afba - total) >>> 0, head.newOffset + 8);
  }
  return out;
}

async function loadFontBuffer(candidates: string[], wantBold: boolean): Promise<Buffer | null> {
  for (const cand of candidates) {
    try {
      const file = await fs.readFile(cand);
      if (file.toString("ascii", 0, 4) === "ttcf") {
        const names = ttcPostscriptNames(file);
        let best = -1;
        let bestScore = -Infinity;
        names.forEach((n, i) => {
          const s = scoreFontName(n, wantBold);
          if (s > bestScore) {
            bestScore = s;
            best = i;
          }
        });
        if (best >= 0 && bestScore > -100) return extractTtfFromTtc(file, best);
        continue;
      }
      return file;
    } catch {
      continue;
    }
  }
  return null;
}

let fontCache: { regular: Buffer; bold: Buffer } | null = null;

async function loadCjkFonts(): Promise<{ regular: Buffer; bold: Buffer }> {
  if (fontCache) return fontCache;
  const regular = await loadFontBuffer(REGULAR_CANDIDATES, false);
  if (!regular) {
    throw new DailyPdfFontError(
      `找不到中文字体，PDF 无法保证中文不乱码（已找：${REGULAR_CANDIDATES.join("、")}；` +
        "可用环境变量 PDF_CJK_FONT 指向一个 .ttf/.ttc 中文字体文件）",
    );
  }
  // 粗体找不到时用常规体顶上（不乱码，只是标题不加粗）
  const bold = (await loadFontBuffer(BOLD_CANDIDATES, true)) ?? regular;
  fontCache = { regular, bold };
  return fontCache;
}

// ── PDFKit 渲染 ──

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN_X = 42;
const MARGIN_TOP = 42;
const MARGIN_BOTTOM = 50;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const NAVY = "#1F3A5F"; // 第一版藏青
const GRAY = "#666666";
const LIGHT_LINE = "#DDDDDD";
const ZEBRA = "#F5F7FA";
const UP_RED = "#C0392B";
const DOWN_GREEN = "#1E7A4C";

function safeText(s: string): string {
  return stripEmoji(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** 第一版封面日期行：从 model.title 里取最后一个日期 + 时段，如“2026 年 10 月 16 日（周五）· 晚报” */
function coverDateLine(title: string): string {
  const dates = title.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const dateStr = dates[dates.length - 1];
  let slotLabel = "日报";
  if (title.includes("早报")) slotLabel = "早报";
  else if (title.includes("午报")) slotLabel = "午盘日报";
  else if (title.includes("晚报")) slotLabel = "晚报";
  else if (title.includes("周报")) slotLabel = "周报";
  if (!dateStr) return `MyDesk 日报 · ${slotLabel}`;
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = ["日", "一", "二", "三", "四", "五", "六"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y} 年 ${m} 月 ${d} 日（周${wd}）· ${slotLabel}`;
}

/** 噜噜头像（scripts/avatar-lulu-cover.png，正方形 PNG）；读不到时返回 null，不阻塞生成 */
async function loadAvatarPng(): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(process.cwd(), "scripts", "avatar-lulu-cover.png"));
  } catch {
    return null;
  }
}

export async function renderPdf(model: PdfDocModel): Promise<Buffer> {
  const fonts = await loadCjkFonts();
  const coverLine = coverDateLine(model.title);
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_X, right: MARGIN_X },
    bufferPages: true,
    info: { Title: "MyDesk 日报", Author: "MyDesk", Subject: coverLine, Creator: "MyDesk" },
  });
  doc.registerFont("CJK", fonts.regular);
  doc.registerFont("CJKBold", fonts.bold);

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const ensureSpace = (h: number): void => {
    if (doc.y + h > PAGE_H - MARGIN_BOTTOM) doc.addPage();
  };
  const hline = (color: string, width = 1): void => {
    const y = doc.y;
    doc.save().strokeColor(color).lineWidth(width).moveTo(MARGIN_X, y).lineTo(PAGE_W - MARGIN_X, y).stroke().restore();
    doc.y = y + 4;
    doc.x = MARGIN_X;
  };

  // ── 封面（第一版）：噜噜头像（圆形裁切）+ “MyDesk 日报” + 日期·时段。
  //   不放副标题、不放生成时间/数据来源元信息行、不放目录、不放附录（用户 2026-10-17 定：附录数据说明去掉）。
  const avatar = await loadAvatarPng();
  if (avatar) {
    const AV_SIZE = 96;
    const avX = (PAGE_W - AV_SIZE) / 2;
    const avY = doc.y;
    doc.save();
    doc.circle(avX + AV_SIZE / 2, avY + AV_SIZE / 2, AV_SIZE / 2).clip();
    doc.image(avatar, avX, avY, { width: AV_SIZE, height: AV_SIZE });
    doc.restore();
    doc.y = avY + AV_SIZE + 14;
    doc.x = MARGIN_X;
  }
  doc.font("CJKBold").fontSize(26).fillColor(NAVY).text("MyDesk 日报", MARGIN_X, doc.y, { width: CONTENT_W, align: "center" });
  doc.y += 8;
  doc.x = MARGIN_X;
  doc.font("CJK").fontSize(11).fillColor("#333333").text(safeText(coverLine), MARGIN_X, doc.y, { width: CONTENT_W, align: "center" });
  doc.y += 16;
  doc.x = MARGIN_X;

  const drawTable = (table: PdfTable): void => {
    const n = table.headers.length;
    const weights = table.widths && table.widths.length === n ? table.widths : Array(n).fill(1);
    const totalW = weights.reduce((a, b) => a + b, 0);
    const colW = weights.map((w) => (w / totalW) * CONTENT_W);
    const padX = 5;
    const padY = 4;
    const HEADER_H = 20;

    // 表格总高（表头 + 所有行 + 尾部空隙），用于“整表原子”判定：
    // 一页能塞下整张表 → 剩余空间不够时整张移到下一页，绝不从中间劈开；
    // 一页塞不下整张表（超长表）→ 才按行断页，且断点只在行与行之间、表头重复。
    const tableTotalHeight = (): number => {
      doc.font("CJK").fontSize(9);
      let rowsH = 0;
      for (const row of table.rows) {
        const cellH = row.map((cell, i) =>
          doc.heightOfString(safeText(cleanCell(cell)), { width: colW[i] - padX * 2 }),
        );
        rowsH += Math.max(...cellH, 12) + padY * 2;
      }
      return HEADER_H + rowsH + 6;
    };
    const usableFull = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM;
    if (tableTotalHeight() <= usableFull && doc.y + tableTotalHeight() > PAGE_H - MARGIN_BOTTOM) {
      doc.addPage();
    }

    const drawHeader = (): void => {
      const h = HEADER_H;
      ensureSpace(h + 2);
      const y = doc.y;
      doc.save().fillColor(NAVY).rect(MARGIN_X, y, CONTENT_W, h).fill().restore();
      let x = MARGIN_X;
      doc.font("CJKBold").fontSize(9).fillColor("#FFFFFF");
      table.headers.forEach((head, i) => {
        doc.text(safeText(head), x + padX, y + padY, { width: colW[i] - padX * 2, align: "left" });
        x += colW[i];
      });
      doc.fillColor("#000000");
      doc.y = y + h;
    };

    drawHeader();
    table.rows.forEach((row, ri) => {
      doc.font("CJK").fontSize(9);
      const cellH = row.map((cell, i) => doc.heightOfString(safeText(cleanCell(cell)), { width: colW[i] - padX * 2 }));
      const rowH = Math.max(...cellH, 12) + padY * 2;
      if (doc.y + rowH > PAGE_H - MARGIN_BOTTOM) {
        doc.addPage();
        drawHeader();
      }
      const y = doc.y;
      if (ri % 2 === 1) doc.save().fillColor(ZEBRA).rect(MARGIN_X, y, CONTENT_W, rowH).fill().restore();
      // 第一版表格：无单元格边框，只有表头色块 + 斑马纹
      let x = MARGIN_X;
      doc.fillColor("#000000");
      row.forEach((cell, i) => {
        doc.text(safeText(cleanCell(cell)), x + padX, y + padY, { width: colW[i] - padX * 2, align: "left" });
        x += colW[i];
      });
      doc.y = y + rowH;
    });
    doc.x = MARGIN_X;
    doc.moveDown(0.4);
  };

  const drawBars = (bars: PdfBars): void => {
    if (!bars.items.length) return;
    doc.font("CJKBold").fontSize(10.5).fillColor(NAVY).text(safeText(bars.title), { width: CONTENT_W });
    doc.moveDown(0.2);
    const labelW = 118;
    const valueW = 92;
    const chartW = CONTENT_W - labelW - valueW - 8;
    const maxAbs = Math.max(...bars.items.map((it) => Math.abs(it.value)), 0.0001);
    for (const it of bars.items) {
      ensureSpace(20);
      const y = doc.y;
      doc.font("CJK").fontSize(9).fillColor("#333333")
        .text(safeText(it.label), MARGIN_X, y + 2, { width: labelW - 6, align: "right" });
      const chartX = MARGIN_X + labelW;
      doc.save().fillColor("#EDF0F4").rect(chartX, y + 3, chartW, 9).fill().restore();
      const barW = Math.max(2, (Math.abs(it.value) / maxAbs) * chartW);
      if (it.value !== 0) {
        doc.save().fillColor(it.value >= 0 ? UP_RED : DOWN_GREEN).rect(chartX, y + 3, barW, 9).fill().restore();
      }
      doc.font("CJK").fontSize(9).fillColor("#333333")
        .text(safeText(it.display), chartX + chartW + 8, y + 2, { width: valueW, align: "left" });
      doc.y = y + 18;
    }
    if (bars.note) {
      doc.font("CJK").fontSize(8.5).fillColor(GRAY).text(safeText(bars.note), { width: CONTENT_W });
      doc.moveDown(0.3);
    }
    doc.x = MARGIN_X;
    doc.moveDown(0.3);
  };

  // ── 各节 ──
  for (const s of model.sections) {
    ensureSpace(56);
    doc.font("CJKBold").fontSize(13).fillColor(NAVY).text(safeText(s.title), { width: CONTENT_W });
    doc.moveDown(0.15);
    hline(LIGHT_LINE, 1);
    doc.moveDown(0.2);
    for (const p of s.paragraphs) {
      doc.font("CJK").fontSize(10).fillColor("#111111").text(safeText(p), {
        width: CONTENT_W, align: "left", lineGap: 4,
      });
      doc.moveDown(0.45);
    }
    if (s.bars) drawBars(s.bars);
    if (s.table) drawTable(s.table);
    if (s.aiCards) {
      for (const card of s.aiCards) {
        // AI 卡整卡原子：标题 + 3 行简介 + 11 字段表，一页能塞下整张卡 → 剩余空间不够时
        // 整张卡移到下一页，不让标题留在上一页、表跑到下一页；卡本身超一页时才由
        // drawTable 按行断（表头重复）兜底。
        {
          const cardTable: PdfTable = {
            headers: ["字段", "内容"],
            rows: card.fields.map((f) => [f.label, f.value]),
            widths: [1.1, 4.5],
          };
          const cardWeights = cardTable.widths!;
          const cardTotalW = cardWeights.reduce((a, b) => a + b, 0);
          const cardColW = cardWeights.map((w) => (w / cardTotalW) * CONTENT_W);
          doc.font("CJKBold").fontSize(11);
          let cardH = doc.heightOfString(
            safeText(`${card.symbol}${card.name ? ` ${card.name}` : ""}`),
            { width: CONTENT_W },
          ) + 3;
          doc.font("CJK").fontSize(9.5);
          for (const [label, value] of [["入选理由", card.reason], ["入场条件", card.entryCondition], ["主要风险", card.mainRisk]] as const) {
            if (!value) continue;
            cardH += doc.heightOfString(`${label}：${safeText(value)}`, { width: CONTENT_W, lineGap: 3 }) + 3;
          }
          doc.font("CJK").fontSize(9);
          let cardRowsH = 0;
          for (const row of cardTable.rows) {
            const cellH = row.map((cell, i) =>
              doc.heightOfString(safeText(cleanCell(cell)), { width: cardColW[i] - 5 * 2 }),
            );
            cardRowsH += Math.max(...cellH, 12) + 4 * 2;
          }
          cardH += 20 + cardRowsH + 6;
          const usableFull = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM;
          if (cardH <= usableFull && doc.y + cardH > PAGE_H - MARGIN_BOTTOM) doc.addPage();
        }
        doc.font("CJKBold").fontSize(11).fillColor(NAVY)
          .text(safeText(`${card.symbol}${card.name ? ` ${card.name}` : ""}`), { width: CONTENT_W });
        doc.moveDown(0.2);
        for (const [label, value] of [["入选理由", card.reason], ["入场条件", card.entryCondition], ["主要风险", card.mainRisk]] as const) {
          if (!value) continue;
          doc.font("CJK").fontSize(9.5).fillColor("#111111")
            .text(`${label}：${safeText(value)}`, { width: CONTENT_W, lineGap: 3 });
          doc.moveDown(0.25);
        }
        drawTable({
          headers: ["字段", "内容"],
          rows: card.fields.map((f) => [f.label, f.value]),
          widths: [1.1, 4.5],
        });
      }
    }
    doc.moveDown(0.4);
  }

  // ── 页脚（所有页，第一版）：只居中一行“ MyDesk 日报 · 第 X 页”，不画分隔线。
  // 注意：不能给 text() 传 width/align——PDFKit 会把带 width 的 text 当流式
  // 文本做换行/断页，在 switchToPage 后的页上会凭空多出一页空白页（实测）。
  // 页脚居中改手动算 x，只传 (str, x, y, {lineBreak:false})。
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const footerText = `MyDesk 日报 · 第 ${i + 1} 页`;
    doc.font("CJK").fontSize(8.5).fillColor(GRAY);
    const footerX = MARGIN_X + Math.max(0, (CONTENT_W - doc.widthOfString(footerText)) / 2);
    doc.text(footerText, footerX, PAGE_H - 32, { lineBreak: false });
  }

  doc.end();
  return done;
}

// ── 数据组装：日报 ──

const INDEX_DEFS = [
  { symbol: "000001.SH", label: "上证指数" },
  { symbol: "399001.SZ", label: "深证成指" },
  { symbol: "399006.SZ", label: "创业板指" },
] as const;

async function fetchIndexRows(dataDate: string): Promise<{ rows: { label: string; date: string | null; close: number | null; changePct: number | null }[]; note: string }> {
  const rows: { label: string; date: string | null; close: number | null; changePct: number | null }[] = [];
  try {
    const per = await Promise.all(INDEX_DEFS.map(async (def) => {
      try {
        const bars = await db.stockDailyBar.findMany({
          where: { symbol: def.symbol, tradeDate: { lte: dataDate } },
          orderBy: { tradeDate: "desc" },
          take: 2,
          select: { tradeDate: true, close: true },
        });
        return { def, bars };
      } catch {
        return { def, bars: [] as { tradeDate: string; close: number }[] };
      }
    }));
    for (const { def, bars } of per) {
      if (!bars.length) {
        rows.push({ label: def.label, date: null, close: null, changePct: null });
        continue;
      }
      const changePct = bars.length >= 2 && bars[1].close > 0
        ? (bars[0].close / bars[1].close - 1) * 100
        : null;
      rows.push({ label: def.label, date: bars[0].tradeDate, close: bars[0].close, changePct });
    }
  } catch {
    return { rows: [], note: "大盘：指数日 K 没取到，算不出大盘涨跌。" };
  }
  const valid = rows.filter((r) => r.date != null && r.close != null);
  if (!valid.length) return { rows: [], note: "大盘：指数日 K 没取到，算不出大盘涨跌。" };
  const note = `大盘：${valid.map((r) => `${r.label}（${r.date}）收 ${r.close?.toFixed(2)}，${r.changePct == null ? "涨跌幅没取到" : `较前一交易日${r.changePct >= 0 ? "涨" : "跌"} ${Math.abs(r.changePct).toFixed(2)}%`}`).join("；")}。`;
  return { rows, note };
}

export async function fetchDailyPdfBuffer(slot: ReportSlot, issueDate: string): Promise<Buffer> {
  const today = shanghaiDate();
  // 历史日期：只有落档正文，不拿今天的数据冒充当天
  if (issueDate !== today) {
    const stored = await readStoredReport(issueDate, slot);
    if (!stored) {
      throw new DailyPdfNotFoundError(`${issueDate} 的${slot}日报没有落档（当天可能休市、或定时器没跑到）`);
    }
    const model = buildStoredTextPdfModel({
      slotTitle: stored.title,
      issueDate: stored.issueDate,
      dataDate: stored.dataDate,
      dataBelongsTo: stored.dataBelongsTo,
      generatedAt: stored.generatedAt,
      preliminary: stored.preliminary,
      sections: stored.sections.map((s) => ({ title: s.title, plain: s.plain })),
      missing: stored.missing,
    });
    return renderPdf(model);
  }

  const report = await fetchThreeDailyReport(slot, new Date());
  // 瘦身版（非交易日）：只渲染落档正文三节，不拉 A 股结构化数据（不重推昨天 A 股内容）。
  if (report.slim) {
    const slimModel = buildStoredTextPdfModel({
      slotTitle: report.title,
      issueDate: report.issueDate,
      dataDate: report.dataDate,
      dataBelongsTo: report.dataBelongsTo,
      generatedAt: report.generatedAt,
      preliminary: report.preliminary,
      sections: report.sections.map((s) => ({ title: s.title, plain: s.plain })),
      missing: report.missing,
      subtitle: "非交易日瘦身版：美股 + 重大新闻 + 财联社新闻 + 下周大事日历 + 周末政策面 + 大宗商品 / 汇率 / 比特币 + 周末公司公告 + 港股周五收盘 / AH 溢价",
      historicalNote: false,
    });
    return renderPdf(slimModel);
  }
  const [bySector, reduction, limitUpResult, aiRow, index] = await Promise.all([
    fetchDailyReportBySector().catch(() => null),
    fetchDailyReductionRisk(report.dataDate).catch(() => null),
    computeLimitUp().catch(() => null),
    db.strategyPick.findFirst({
      where: { tradeDate: report.dataDate, strategyId: -1, source: "ai_pick" },
      orderBy: { pickedAt: "desc" },
      select: { symbols: true, symbolsNote: true },
    }).catch(() => null),
    fetchIndexRows(report.dataDate),
  ]);

  // AI 优选：逐只 11 字段卡（解析 symbolsNote；旧格式 → 原文）
  const note = (aiRow?.symbolsNote ?? "").trim();
  const parsedCards = parseAiPickNote(note);
  // 决策日卡片：结构不变，只去掉字段值里的选股日涨跌幅数字（没意义，不是收益）
  const stripOrMissing = (v: string | null | undefined): string | undefined => {
    if (v == null) return undefined;
    const s = stripPickDayChangePct(v);
    return s ? s : undefined;
  };
  const aiCards: PdfAiCard[] = parsedCards.map((c) => ({
    symbol: c.symbol,
    name: c.name,
    reason: stripOrMissing(c.reason),
    entryCondition: stripOrMissing(c.entryCondition),
    mainRisk: stripOrMissing(c.mainRisk),
    fields: AI_PICK_CARD_FIELDS.map((f) => {
      const raw = c[f.key] as string | null;
      return {
        label: f.label,
        value: raw == null ? AI_PICK_MISSING : (stripPickDayChangePct(raw) || AI_PICK_MISSING),
      };
    }),
  }));
  let pickNames: string[] = [];
  try {
    const syms = JSON.parse(aiRow?.symbols ?? "[]") as { symbol?: string; name?: string }[];
    pickNames = syms.map((s) => `${s.name || ""}（${s.symbol || ""}）`.trim()).filter((x) => x !== "（）");
  } catch {
    pickNames = [];
  }
  const noteText = !aiRow
    ? ""
    : parsedCards.length
      ? ""
      : note.length > 1500
        ? `${note.slice(0, 1500)}……（已截断，完整版见 AI 优选战绩记录）`
        : note;

  // 涨停龙头：上游 tiers 会重叠（如“最高板”与“3连板+”都含同一只），按代码去重
  const flatLeaders = limitUpResult
    ? pickLimitUpLeaders(limitUpResult.tiers.flatMap((t) => t.stocks).map((s) => ({
        symbol: s.symbol, name: s.name, boards: s.boards, changePct: s.changePct,
      }))).filter((s, i, arr) => arr.findIndex((x) => x.symbol === s.symbol) === i)
    : [];

  // 分歧
  const divergences = bySector
    ? pickDivergenceHighlights(bySector.cards.map((c) => ({
        name: c.name, changePct: c.changePct, netYi: c.netYi, plain: c.plain,
      })))
    : [];

  // 本期看什么：只取正文里没被结构化八节覆盖的叙事节
  const watchKeys = slot === "morning" ? new Set(["watch-today", "risk"]) : slot === "noon" ? new Set(["afternoon-watch"]) : new Set<string>();
  const watchSections = report.sections.filter((s) => watchKeys.has(s.key)).map((s) => ({ title: s.title, plain: s.plain }));

  const model = buildDailyPdfModel({
    slotLabel: report.label,
    slotTitle: report.title,
    issueDate: report.issueDate,
    dataDate: report.dataDate,
    dataBelongsTo: report.dataBelongsTo,
    generatedAt: report.generatedAt,
    preliminary: report.preliminary,
    timeShift: slot === "morning" ? "yesterday" : slot === "noon" ? "morning" : "none",
    market: index.rows,
    marketNote: index.note,
    sectorFlowPlain: bySector?.sectorFlow.plain ?? "今日板块资金：没取到，算不出钱去了哪。",
    branchFlowPlain: bySector?.sectorBranches.plain ?? null,
    branchFlowHasData: bySector?.sectorBranches.hasData ?? false,
    topInflow: bySector?.sectorFlow.topInflow ?? [],
    topOutflow: bySector?.sectorFlow.topOutflow ?? [],
    sectorFlowHasData: bySector?.sectorFlow.hasData ?? false,
    divergences,
    divergenceHasData: (bySector?.hasData ?? false) || divergences.length > 0,
    limitUp: {
      count: limitUpResult?.limit_up_count ?? null,
      maxBoards: limitUpResult?.max_boards ?? null,
      touched: limitUpResult?.touched_count ?? null,
      broken: limitUpResult?.broken_count ?? null,
      asOf: limitUpResult?.trade_date ?? limitUpResult?.as_of ?? null,
      leaders: flatLeaders,
      hasData: limitUpResult != null,
    },
    reduction: {
      total: reduction?.total ?? 0,
      bigHolderCount: reduction?.bigHolderCount ?? 0,
      rows: (reduction?.rows ?? []).map((r) => ({
        code: r.code, name: r.name, holder: r.holder, stage: r.stage, plainLine: r.plainLine,
      })),
      plain: reduction?.plain ?? "减持风险：巨潮公告没取到，算不出今天谁在减持。",
      hasData: reduction?.hasData ?? false,
    },
    aiPick: {
      hasRow: aiRow != null,
      cards: aiCards,
      noteText,
      pickNames: pickNames.length ? pickNames : aiCards.map((c) => `${c.name || ""}（${c.symbol}）`.trim()),
    },
    usMarket: {
      quotes: bySector?.usMarket.quotes ?? [],
      plain: bySector?.usMarket.plain ?? "美股：昨晚收盘没取到，算不出对 A 股的影响。",
      hasData: bySector?.usMarket.hasData ?? false,
    },
    fed: {
      meetings: (bySector?.fed.meetings ?? []).map((m) => ({
        meeting: m.meeting, kalshi: m.kalshiHikePct, polymarket: m.polymarketHikePct, avg: m.avgHikePct,
      })),
      plain: bySector?.fed.plain ?? "美联储 / 预测市场：Kalshi 和 Polymarket 都没取到，算不出加息概率。",
      hasData: bySector?.fed.hasData ?? false,
    },
    mainLinePlain: bySector?.mainLineReduction.plain ?? "主线：板块数据没取到，算不出今天的主线。",
    watchSections,
    missing: report.missing,
  });
  return renderPdf(model);
}

// ── 数据组装：周报 ──

export async function fetchWeeklyPdfBuffer(date: string): Promise<Buffer> {
  const { sunday } = weekRangeOf(date);
  const archived = loadArchivedWeeklyReport(sunday);
  const report = archived?.report ?? (await fetchWeeklyReport(sunday));
  const nextSun = addDays(sunday, 7);
  const fedNext = report.fedMeetings.filter((m) => m.date != null && m.date >= addDays(sunday, 1) && m.date <= nextSun);
  const fedNextLine = fedNext.length
    ? `下周有美联储议息：${fedNext.map((m) => `${m.meeting}（${m.date}）`).join("、")}，议息前后小心波动。`
    : "下周美联储：已知会议都不在下周；具体日期没取到的会议无法判断。";
  const nextWeekPlain = `下周重点看本周主线能不能续上（${report.mainLine.length ? report.mainLine.map((s) => s.name).join("、") : "本周无明确主线"}），主线断了就先别追。${fedNextLine}`;
  const model = buildWeeklyPdfModel({
    sunday: report.sunday,
    weekStart: report.weekStart,
    weekEnd: report.weekEnd,
    tradingDays: report.tradingDays,
    indexWeeklyPct: report.indexWeeklyPct,
    allAMedianWeeklyPct: report.allAMedianWeeklyPct,
    strongest: report.strongest,
    weakest: report.weakest,
    mainLine: report.mainLine,
    mainLineChange: report.mainLineChange,
    picksPlain: report.picks.plain,
    picksDays: report.picks.days,
    picksFilledDays: report.picks.filledDays,
    avgWinPct: report.picks.avgWinPct,
    avgBenchPct: report.picks.avgBenchPct,
    limitUpLeaders: report.limitUpLeaders,
    fedPlain: report.fedPlain,
    fedMeetings: report.fedMeetings,
    nextWeekTradingDays: report.nextWeekTradingDays,
    nextWeekHolidayWindows: report.nextWeekHolidayWindows,
    nextWeekPlain,
    hasData: report.hasData,
  });
  return renderPdf(model);
}
