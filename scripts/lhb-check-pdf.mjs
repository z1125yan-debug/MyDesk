#!/usr/bin/env node
// 龙虎榜核对 PDF 生成器（pdfkit 版，版式与 DSA 深挖报告一致：头像置顶 + 居中标题）
// 用法：cd ~/workspace/kairotrend-p1 && node scripts/lhb-check-pdf.mjs 2026-10-20
// 输入：goals/mydesk.../hidden_files/lhb-check-<日期>.md（## 分节、- 或数字. 条目、普通行段落）
// 输出：goals/mydesk.../files/龙虎榜核对-<日期>.pdf + your_files 软链。数据缺失留空，绝不编造。
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import * as fontkit from "fontkit";

const HOME = process.env.HOME || "/home/hatch";
const REPO = path.join(HOME, "workspace/kairotrend-p1");
const GOAL = path.join(HOME, "workspace/goals/mydesk-market-data-and-stock-picking-workflow");
const FILES_DIR = path.join(GOAL, "files");
const YOUR_FILES = path.join(HOME, "workspace/your_files");

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

function loadFont(candidates) {
  for (const p of candidates) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      const buf = fs.readFileSync(p);
      const coll = fontkit.create(buf);
      const fonts = coll.fonts || [coll];
      return fonts.find((f) => /SC\b/i.test(f.fullName || "")) || fonts[0];
    } catch { /* try next */ }
  }
  return null;
}

function main() {
  const date = process.argv[2];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    console.error("用法: node scripts/lhb-check-pdf.mjs YYYY-MM-DD");
    process.exit(1);
  }
  const mdPath = path.join(GOAL, "hidden_files", `lhb-check-${date}.md`);
  if (!fs.existsSync(mdPath)) {
    console.error(`找不到 ${mdPath}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(mdPath, "utf-8").split(/\r?\n/);

  // 极简 md 子集解析：# 文档标题（跳过，自渲染标题区）、## 分节、其余非空行为段落
  const sections = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("# ")) continue;
    if (line.startsWith("## ")) {
      cur = { heading: line.slice(3).trim(), paras: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) {
      cur = { heading: "", paras: [] };
      sections.push(cur);
    }
    cur.paras.push(line.replace(/\*\*/g, ""));
  }

  const regular = loadFont(FONT_CANDIDATES);
  if (!regular) throw new Error("找不到中文字体，PDF 无法生成");
  const bold = loadFont(FONT_BOLD_CANDIDATES) || regular;

  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.mkdirSync(YOUR_FILES, { recursive: true });
  const pdfName = `龙虎榜核对-${date}.pdf`;
  const pdfPath = path.join(FILES_DIR, pdfName);

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 42, bottom: 50, left: 42, right: 42 },
    bufferPages: true,
    info: { Title: `龙虎榜核对 ${date}`, Author: "MyDesk" },
  });
  doc.registerFont("CJK", regular);
  doc.registerFont("CJKB", bold);
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  const W = 595.28, H = 841.89, MX = 42, MB = 50;
  const CW = W - MX * 2;
  const NAVY = "#1F3A5F";
  const need = (h) => { if (doc.y + h > H - MB) doc.addPage(); };
  const para = (text, { size = 10.5, gap = 6 } = {}) => {
    need(size * 2.4);
    doc.font("CJK").fontSize(size).fillColor("#000000").text(text, { width: CW, align: "left" });
    doc.moveDown(gap / 12);
  };
  const h1 = (text) => {
    need(44);
    doc.moveDown(0.6);
    doc.font("CJKB").fontSize(14).fillColor(NAVY).text(text, { width: CW });
    doc.moveDown(0.3);
    doc.strokeColor("#DDDDDD").lineWidth(0.5).moveTo(MX, doc.y).lineTo(MX + CW, doc.y).stroke();
    doc.moveDown(0.4);
  };

  // 标题区：头像置顶（同日报版式：圆形裁切、居中 96×96）+ 标题
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
    .text("龙虎榜核对", MX, doc.y, { width: CW, align: "center" });
  doc.moveDown(0.5);
  const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(`${date}T12:00:00+08:00`).getDay()];
  doc.font("CJK").fontSize(9).fillColor("#555555")
    .text(`核对日期：${date}（${wd}）　数据来源：东方财富龙虎榜（交易所交易公开信息）`, { width: CW, align: "center" });
  doc.moveDown(0.8);

  for (const sec of sections) {
    if (sec.heading) h1(sec.heading);
    for (const p of sec.paras) para(p);
  }

  return new Promise((resolve, reject) => {
    stream.on("finish", () => {
      const link = path.join(YOUR_FILES, pdfName);
      try { if (fs.existsSync(link) || fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch { /* ignore */ }
      fs.symlinkSync(path.relative(YOUR_FILES, pdfPath), link);
      console.log(`RESULT=OK PDF=${pdfPath}`);
      resolve();
    });
    stream.on("error", reject);
    doc.end();
  });
}

main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
