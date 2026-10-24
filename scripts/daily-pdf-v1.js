// 第一版日报 PDF · 共享渲染器（Node 直跑，供脚本生成用）。
//
// 与 scripts/generate-midday-v1-fixed.js 同款渲染（已验证）：
//   封面 = 噜噜头像（圆形裁切）+ “MyDesk 日报” + 日期·时段一行，
//   不放副标题、不放生成时间/数据来源元信息行、不放目录；
//   表格整表原子（能塞一页的整表移到下一页，绝不半路截断；超长表按行断、表头重复）；
//   AI 卡整卡原子；页脚手动居中，不传 width/align（不产生空白页脚页）。
// 用法：
//   const { renderV1Pdf } = require("./daily-pdf-v1");
//   await renderV1Pdf({ outPath, coverDateLine, preamble, sections, appendix });

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 42;
const MARGIN_TOP = 42;
const MARGIN_BOTTOM = 50;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const NAVY = "#1F3A5F";
const GRAY = "#666666";

// --- 字体：与 daily-report-pdf.ts 同源（系统 Noto Sans CJK，TTC 抽单个 TTF）---
function findFont(paths) {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function decodeNameString(buf, platform) {
  try {
    if (platform === 1) return buf.toString("latin1");
    if (platform === 3) {
      const swapped = Buffer.alloc(buf.length);
      for (let i = 0; i + 1 < buf.length; i += 2) { swapped[i] = buf[i + 1]; swapped[i + 1] = buf[i]; }
      return swapped.toString("utf16le");
    }
    return buf.toString("utf8");
  } catch { return null; }
}
function ttcPostscriptNames(ttc) {
  try {
    if (ttc.toString("ascii", 0, 4) !== "ttcf") return [];
    const num = ttc.readUInt32BE(8);
    const names = [];
    for (let i = 0; i < num; i++) {
      const off = ttc.readUInt32BE(12 + i * 4);
      const numTables = ttc.readUInt16BE(off + 4);
      let nameOff = -1, nameLen = 0;
      for (let t = 0; t < numTables; t++) {
        const r = off + 12 + t * 16;
        if (ttc.toString("ascii", r, r + 4) === "name") { nameOff = ttc.readUInt32BE(r + 8); nameLen = ttc.readUInt32BE(r + 12); break; }
      }
      if (nameOff < 0) { names.push(null); continue; }
      const count = ttc.readUInt16BE(nameOff + 2);
      const stringOff = ttc.readUInt16BE(nameOff + 4);
      let ps = null;
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
        if (s) { ps = s; break; }
      }
      names.push(ps);
    }
    return names;
  } catch { return []; }
}
function scoreFontName(name, wantBold) {
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
function extractTtfFromTtc(ttc, index) {
  const num = ttc.readUInt32BE(8);
  if (index < 0 || index >= num) throw new Error(`TTC 字体序号越界：${index}/${num}`);
  const off = ttc.readUInt32BE(12 + index * 4);
  const sfntVersion = ttc.readUInt32BE(off);
  const numTables = ttc.readUInt16BE(off + 4);
  const records = [];
  for (let i = 0; i < numTables; i++) {
    const r = off + 12 + i * 16;
    records.push({ tag: ttc.toString("ascii", r, r + 4), offset: ttc.readUInt32BE(r + 8), length: ttc.readUInt32BE(r + 12) });
  }
  records.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const headerLen = 12 + numTables * 16;
  let dataOff = headerLen;
  const placed = records.map((rec) => { const newOffset = dataOff; dataOff += Math.ceil(rec.length / 4) * 4; return { ...rec, newOffset }; });
  const out = Buffer.alloc(dataOff);
  out.writeUInt32BE(sfntVersion, 0);
  out.writeUInt16BE(numTables, 4);
  const pow2 = Math.pow(2, Math.floor(Math.log2(Math.max(1, numTables))));
  out.writeUInt16BE(16 * pow2, 6);
  out.writeUInt16BE(Math.log2(pow2), 8);
  out.writeUInt16BE(numTables * 16 - 16 * pow2, 10);
  let p = 12;
  for (const rec of placed) {
    out.write(rec.tag, p, "ascii"); p += 4;
    out.writeUInt32BE(0, p); p += 4;
    out.writeUInt32BE(rec.newOffset, p); p += 4;
    out.writeUInt32BE(rec.length, p); p += 4;
  }
  for (const rec of placed) ttc.copy(out, rec.newOffset, rec.offset, rec.offset + rec.length);
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
function pickTtcIndex(ttc, wantBold) {
  const names = ttcPostscriptNames(ttc);
  let best = -1, bestScore = -Infinity;
  names.forEach((n, i) => { const s = scoreFontName(n, wantBold); if (s > bestScore) { bestScore = s; best = i; } });
  return best >= 0 && bestScore > -100 ? best : 0;
}
function loadCjkFonts() {
  const reg = findFont([
    process.env.PDF_CJK_FONT || "",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
  ]);
  const bold = findFont([
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
  ]);
  if (!reg) throw new Error("找不到中文字体");
  const regBuf = fs.readFileSync(reg);
  const regular = regBuf.toString("ascii", 0, 4) === "ttcf" ? extractTtfFromTtc(regBuf, pickTtcIndex(regBuf, false)) : regBuf;
  let boldBuf = regular;
  if (bold) {
    const bBuf = fs.readFileSync(bold);
    boldBuf = bBuf.toString("ascii", 0, 4) === "ttcf" ? extractTtfFromTtc(bBuf, pickTtcIndex(bBuf, true)) : bBuf;
  }
  return { regular, bold: boldBuf };
}
function safeText(s) {
  return String(s ?? "").replace(/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD]/g, "");
}

/**
 * 第一版样式渲染。
 * @param {string} outPath 输出 PDF 路径
 * @param {string} coverDateLine 封面日期行，如“2026 年 10 月 16 日（周五）· 晚报”
 * @param {string} [preamble] 封面后的一段说明（如数据口径），可空
 * @param {Array<{heading: string, blocks: Array<{kind: "para"|"sub"|"table"|"aiCard"|"divider"|"key", text?: string, table?: object, card?: {title: string, fields: Array<[string,string]>}}>}>} sections
 * （附录已按用户要求去掉，2026-10-17：不再渲染附录数据说明。调用方传 appendix 会被忽略。）
 * @param {string} [coverTitle] 封面大标题，默认“MyDesk 日报”（周报传“MyDesk 周报”）
 */
async function renderV1Pdf({ outPath, coverDateLine, preamble, sections, coverTitle }) {
  const TITLE = coverTitle || "MyDesk 日报";
  const fonts = loadCjkFonts();
  const doc = new PDFDocument({ size: "A4", margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_X, right: MARGIN_X }, bufferPages: true, info: { Title: TITLE, Author: "MyDesk" } });
  doc.registerFont("CJK", fonts.regular);
  doc.registerFont("CJKBold", fonts.bold);
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", (c) => chunks.push(Buffer.from(c)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const usableFull = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM;
  const ensureSpace = (h) => { if (doc.y + h > PAGE_H - MARGIN_BOTTOM) doc.addPage(); };
  const paraHeight = (text, size, font) => {
    doc.font(font).fontSize(size);
    return doc.heightOfString(safeText(text), { width: CONTENT_W }) + 2;
  };
  const para = (text, size = 10, font = "CJK", color = "#111111", gap = 6) => {
    const h = paraHeight(text, size, font);
    if (h <= usableFull && doc.y + h > PAGE_H - MARGIN_BOTTOM) doc.addPage();
    doc.x = MARGIN_X;
    doc.font(font).fontSize(size).fillColor(color).text(safeText(text), MARGIN_X, doc.y, { width: CONTENT_W });
    doc.y += gap;
    doc.x = MARGIN_X;
  };
  const sectionTitle = (text) => {
    ensureSpace(24);
    doc.x = MARGIN_X;
    doc.font("CJKBold").fontSize(13).fillColor(NAVY).text(safeText(text), MARGIN_X, doc.y, { width: CONTENT_W });
    doc.y += 8;
    doc.x = MARGIN_X;
  };
  const subTitle = (text) => {
    ensureSpace(20);
    doc.x = MARGIN_X;
    doc.font("CJKBold").fontSize(10.5).fillColor("#333333").text(safeText(text), MARGIN_X, doc.y, { width: CONTENT_W });
    doc.y += 6;
    doc.x = MARGIN_X;
  };
  const drawTable = (table) => {
    const n = table.headers.length;
    const weights = table.widths && table.widths.length === n ? table.widths : Array(n).fill(1);
    const totalW = weights.reduce((a, b) => a + b, 0);
    const colW = weights.map((w) => (w / totalW) * CONTENT_W);
    const padX = 5, padY = 4, HEADER_H = 20;
    const rowHeights = table.rows.map((row) => {
      doc.font("CJK").fontSize(9);
      const hs = row.map((cell, i) => doc.heightOfString(safeText(cell), { width: colW[i] - padX * 2 }));
      return Math.max(...hs, 12) + padY * 2;
    });
    const totalH = HEADER_H + rowHeights.reduce((a, b) => a + b, 0) + 6;
    if (totalH <= usableFull && doc.y + totalH > PAGE_H - MARGIN_BOTTOM) doc.addPage();
    const drawHeader = () => {
      ensureSpace(HEADER_H + 2);
      const y = doc.y;
      doc.save().fillColor(NAVY).rect(MARGIN_X, y, CONTENT_W, HEADER_H).fill().restore();
      let x = MARGIN_X;
      doc.font("CJKBold").fontSize(9).fillColor("#FFFFFF");
      table.headers.forEach((head, i) => {
        doc.text(safeText(head), x + padX, y + padY, { width: colW[i] - padX * 2, align: "left" });
        x += colW[i];
      });
      doc.fillColor("#000000");
      doc.y = y + HEADER_H;
    };
    drawHeader();
    table.rows.forEach((row, ri) => {
      const rh = rowHeights[ri];
      if (doc.y + rh > PAGE_H - MARGIN_BOTTOM) { doc.addPage(); drawHeader(); }
      const y = doc.y;
      if (ri % 2 === 1) doc.save().fillColor("#F5F7FA").rect(MARGIN_X, y, CONTENT_W, rh).fill().restore();
      let x = MARGIN_X;
      doc.font("CJK").fontSize(9).fillColor("#111111");
      row.forEach((cell, i) => {
        doc.text(safeText(cell), x + padX, y + padY, { width: colW[i] - padX * 2, align: "left" });
        x += colW[i];
      });
      doc.y = y + rh;
    });
    doc.y += 6;
    doc.x = MARGIN_X;
  };
  const drawAiCard = (card) => {
    doc.font("CJKBold").fontSize(10);
    const titleH = doc.heightOfString(safeText(card.title), { width: CONTENT_W }) + 4;
    let fieldsH = 0;
    for (const [k, v] of card.fields) {
      doc.font("CJK").fontSize(9.5);
      fieldsH += doc.heightOfString(safeText(`${k}：${v}`), { width: CONTENT_W }) + 3;
    }
    const totalH = titleH + fieldsH + 10;
    if (totalH <= usableFull && doc.y + totalH > PAGE_H - MARGIN_BOTTOM) doc.addPage();
    doc.x = MARGIN_X;
    doc.font("CJKBold").fontSize(10).fillColor("#111111").text(safeText(card.title), MARGIN_X, doc.y, { width: CONTENT_W });
    doc.y += 4;
    for (const [k, v] of card.fields) {
      const line = `${k}：${v}`;
      const lh = paraHeight(line, 9.5, "CJK");
      if (doc.y + lh > PAGE_H - MARGIN_BOTTOM) doc.addPage();
      doc.x = MARGIN_X;
      doc.font("CJK").fontSize(9.5).fillColor("#333333").text(safeText(line), MARGIN_X, doc.y, { width: CONTENT_W });
      doc.y += 3;
    }
    doc.y += 10;
    doc.x = MARGIN_X;
  };
  // ── 话题隔断：一道浅色横线 + 上下留白（2026-10-23 新增块 kind: "divider"）──
  const drawDivider = () => {
    const need = 5 + 1 + 11;
    if (doc.y + need > PAGE_H - MARGIN_BOTTOM) doc.addPage();
    doc.y += 5;
    doc.save().strokeColor("#D9DEE7").lineWidth(0.8)
      .moveTo(MARGIN_X, doc.y).lineTo(PAGE_W - MARGIN_X, doc.y).stroke().restore();
    doc.y += 11;
    doc.x = MARGIN_X;
  };
  // ── 重点行：加粗 + 浅底色 + 左侧竖线（2026-10-23 新增块 kind: "key"，放结论句/持续性判断）──
  const KEY_BG = "#EEF2F8";
  const drawKey = (text) => {
    const padX = 9, padY = 6, barW = 3;
    const innerW = CONTENT_W - barW - padX * 2;
    doc.font("CJKBold").fontSize(10);
    const th = doc.heightOfString(safeText(text), { width: innerW });
    const totalH = th + padY * 2;
    if (totalH <= usableFull && doc.y + totalH > PAGE_H - MARGIN_BOTTOM) doc.addPage();
    const y = doc.y;
    doc.save().fillColor(KEY_BG).rect(MARGIN_X, y, CONTENT_W, totalH).fill().restore();
    doc.save().fillColor(NAVY).rect(MARGIN_X, y, barW, totalH).fill().restore();
    doc.x = MARGIN_X;
    doc.font("CJKBold").fontSize(10).fillColor("#16283F")
      .text(safeText(text), MARGIN_X + barW + padX, y + padY, { width: innerW });
    doc.y = y + totalH + 8;
    doc.x = MARGIN_X;
  };

  // ── 封面：噜噜头像（圆形裁切）+ 标题 + 日期。去噪：不放副标题与元信息行 ──
  const AVATAR_PNG = path.join(__dirname, "avatar-lulu-cover.png");
  const AV_SIZE = 96;
  const avX = (PAGE_W - AV_SIZE) / 2;
  const avY = doc.y;
  doc.save();
  doc.circle(avX + AV_SIZE / 2, avY + AV_SIZE / 2, AV_SIZE / 2).clip();
  doc.image(AVATAR_PNG, avX, avY, { width: AV_SIZE, height: AV_SIZE });
  doc.restore();
  doc.y = avY + AV_SIZE + 14;
  doc.x = MARGIN_X;
  doc.font("CJKBold").fontSize(26).fillColor(NAVY).text(safeText(TITLE), MARGIN_X, doc.y, { width: CONTENT_W, align: "center" });
  doc.y += 8;
  doc.x = MARGIN_X;
  doc.font("CJK").fontSize(11).fillColor("#333333").text(safeText(coverDateLine), MARGIN_X, doc.y, { width: CONTENT_W, align: "center" });
  doc.y += 16;
  doc.x = MARGIN_X;

  if (preamble) para(preamble, 10, "CJK", "#111111", 12);

  for (const sec of sections) {
    sectionTitle(sec.heading);
    for (const b of sec.blocks) {
      if (b.kind === "sub") subTitle(b.text);
      else if (b.kind === "table") drawTable(b.table);
      else if (b.kind === "aiCard") drawAiCard(b.card);
      else if (b.kind === "divider") drawDivider();
      else if (b.kind === "key") drawKey(b.text);
      else para(b.text);
    }
  }

  // ── 页脚：手动居中，不传 width/align，避免 PDFKit 流式换行产生空白页 ──
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const footer = `${TITLE} · 第 ${i + 1} 页`;
    doc.font("CJK").fontSize(8.5).fillColor(GRAY);
    const tw = doc.widthOfString(safeText(footer));
    doc.text(safeText(footer), (PAGE_W - tw) / 2, PAGE_H - 32, { lineBreak: false });
  }

  doc.end();
  const buf = await done;
  fs.writeFileSync(outPath, buf);
  return { outPath, bytes: buf.length, pages: range.count };
}

module.exports = { renderV1Pdf };
