// 重新生成第一版晚报 PDF（2026-10-16），只做排版，内容逐字取自晚报 md。
// 第一版 UI（对照用户截图的第一版午报）：
//   封面 = 噜噜头像（圆形裁切）+ “MyDesk 日报” + 日期·时段一行，不放副标题/元信息行；
//   顶部摘要 = 浅蓝底框；章节条 = 藏青 #1F3A5F 底白字；
//   表格 = 斑马纹 #F5F7FA，不要单元格边框；表头 = 浅底 #F0F2F7 + 藏青字
//   （第一版原版午报实测：表头底 #F0F2F7、字 #1A3A5C 藏青粗体，与藏青底白字的章节条区分开，
//   不会看着像两个深蓝条叠在一起）。
//   页脚 = 手动居中，不传 width/align（不产生空白页脚页）。
// 分页（用户新要求：长版无缝衔接）：
//   段落逐行流淌，跨页自然接上，不整段跳页留大段空白；
//   表格整表原子（能塞一页的表，空间不够时整张移到下一页，绝不半路截断；超长表按行断，表头重复）；
//   章节标题绝不孤悬页尾（标题 + 至少 2 行内容塞不下，标题整段移到下一页）。
// 用法：node scripts/generate-evening-v1-fixed.js [输出路径]
// 默认覆盖正本：goals/.../files/MyDesk日报-2026-10-16晚报.pdf（不新起文件名）。

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

// --- 字体：与 daily-report-pdf.ts / generate-midday-v1-fixed.js 同源（系统 Noto Sans CJK，TTC 抽单个 TTF）---
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

// --- 晚报内容（逐字取自 hidden_files/evening-report-2026-10-16.md，数字一个字不改）---
const COVER_DATE_LINE = "2026 年 10 月 16 日（周五）· 晚报";

const SUMMARY = "一句话总结：今天（10-16）收盘，上证 3716.28（+0.24%），上午曾涨到 3742.66（+0.95%），下午回落，深证和创业板翻绿收盘——反弹没能续上。主线是军工（国防军工 +4.46%，吸金 29.34 亿）和汽车 / 低空经济。半导体跌 -0.76% 但钱进了 34.22 亿，跌但有钱接；有色金属涨 +0.69% 但钱跑了 14.02 亿，别追。AI 选的 7 只票平均 -1.07%，跑输上证，协和电子跌 8.06% 最弱。";

const INDEX_TABLE = {
  headers: ["指数", "收盘", "涨跌"],
  widths: [1.4, 1, 1],
  rows: [
    ["上证", "3716.28", "+0.24%"],
    ["深证成指", "11802.46", "-0.12%"],
    ["创业板", "2772.38", "-0.39%"],
    ["沪深 300", "4170.61", "+0.11%"],
  ],
};
const BREADTH_TABLE = {
  headers: ["指标", "数值"],
  widths: [1.2, 2.8],
  rows: [
    ["涨 / 跌 / 平", "涨 3285 只 / 跌 2142 只 / 平 148 只"],
    ["中位涨跌", "+0.46%"],
    ["全天成交", "15684.6 亿"],
    ["昨天（10-15）", "涨 435 只 / 跌 5125 只、中位 -3.04%"],
    ["昨天上证收", "3707.48"],
  ],
};
const INFLOW_TABLE = {
  headers: ["板块", "涨跌", "净流入"],
  widths: [1.2, 1, 1.2],
  rows: [
    ["半导体", "-0.76%", "+34.22 亿"],
    ["国防军工", "+4.46%", "+29.34 亿"],
    ["汽车", "+2.13%", "+28.07 亿"],
    ["电子", "-0.85%", "+23.40 亿"],
    ["汽车零部件", "+2.37%", "+19.91 亿"],
  ],
};
const OUTFLOW_TABLE = {
  headers: ["板块", "涨跌", "净流出"],
  widths: [1.2, 1, 1.2],
  rows: [
    ["传媒", "-1.80%", "-36.84 亿"],
    ["非银金融", "-0.84%", "-16.97 亿"],
    ["电池", "-1.58%", "-16.92 亿"],
    ["证券", "-1.23%", "-14.76 亿"],
    ["有色金属", "+0.69%", "-14.02 亿"],
  ],
};
const LEADER_REDUCE_TABLE = {
  headers: ["主线龙头", "近 30 天减持公告"],
  widths: [1.5, 2.5],
  rows: [
    ["长城军工", "0 条"],
    ["保隆科技", "0 条"],
    ["晨曦航空", "0 条"],
    ["甘化科工", "0 条"],
    ["时空科技", "0 条"],
    ["兆易创新", "0 条"],
    ["复旦微电", "0 条"],
    ["拓荆科技", "0 条"],
  ],
};
const DIVERGE_TABLE = {
  headers: ["类型", "板块", "涨跌 / 资金"],
  widths: [1, 1.2, 1.8],
  rows: [
    ["跌但钱进", "半导体", "-0.76% / +34.22 亿"],
    ["跌但钱进", "电子", "-0.85% / +23.40 亿"],
    ["跌但钱进", "半导体设备", "-1.26% / +19.30 亿"],
    ["涨但钱跑", "有色金属", "+0.69% / -14.02 亿"],
    ["涨但钱跑", "电力设备", "+0.30% / -11.33 亿"],
    ["涨但钱跑", "基础化工", "+0.66% / -10.17 亿"],
    ["龙头独涨", "传媒", "板块 -36.84 亿，但新华传媒 11 连板"],
  ],
};
const LIMITUP_TABLE = {
  headers: ["项目", "详情"],
  widths: [1.2, 2.8],
  rows: [
    ["涨停 / 跌停", "78 家涨停、28 家跌停"],
    ["11 连板", "新华传媒（传媒）"],
    ["4 连板", "冰山冷热"],
    ["3 连板", "新华文轩"],
    ["2 连板 4 只", "东方嘉盛、尖峰集团、读者传媒、吉大正元"],
    ["跌停", "28 家里有多只 ST 票"],
    ["炸板率", "未取到（当日无盘中触板数据）"],
  ],
};
const REDUCE_TABLE = {
  headers: ["代码", "名称", "减持情况"],
  widths: [0.8, 1, 2.2],
  rows: [
    ["601360", "三六零", "控股股东减持计划到期，结果公布"],
    ["002884", "凌霄泵业", "董事 / 高管减持计划到期"],
    ["002196", "方正电机", "董事 / 高管减持计划到期"],
    ["002028", "思源电气", "董事 / 高管减持计划到期"],
  ],
};
const AI_TABLE = {
  headers: ["股票", "收盘", "涨跌", "备注"],
  widths: [1.2, 0.8, 0.9, 1.5],
  rows: [
    ["恒瑞医药", "46.63", "+0.06%", ""],
    ["协和电子", "39.00", "-8.06%", "最弱，下午继续跌"],
    ["智莱科技", "11.59", "-1.19%", ""],
    ["迎驾贡酒", "40.00", "+3.63%", "最强"],
    ["舒华体育", "12.25", "-5.62%", ""],
    ["金徽酒", "17.25", "+2.56%", ""],
    ["晋控煤业", "17.95", "+1.13%", ""],
  ],
};
const US_TABLE = {
  headers: ["美股", "收盘", "涨跌"],
  widths: [2, 1, 1],
  rows: [
    ["道指", "52178.99", "+1.08%"],
    ["标普 500", "7744.12", "+0.33%"],
    ["纳指", "26713.03", "+0.08%"],
  ],
};

// --- 渲染 ---
async function main() {
  const outPath = process.argv[2] || path.join(process.env.HOME, "workspace/goals/mydesk-market-data-and-stock-picking-workflow/files/MyDesk日报-2026-10-16晚报.pdf");
  const fonts = loadCjkFonts();
  const doc = new PDFDocument({ size: "A4", margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_X, right: MARGIN_X }, bufferPages: true, info: { Title: "MyDesk 日报", Author: "MyDesk" } });
  doc.registerFont("CJK", fonts.regular);
  doc.registerFont("CJKBold", fonts.bold);
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", (c) => chunks.push(Buffer.from(c)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const usableFull = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM;
  const lineHOf = (size) => size * 1.45;

  // 按词/按字换行（中文按字断，英文单词不断半个词），供流淌段落与摘要框共用
  const wrapLines = (text, font, size, width) => {
    doc.font(font).fontSize(size);
    const tokens = safeText(text).split(/(\s+)/);
    const lines = [];
    let cur = "";
    const push = (s) => { if (s) lines.push(s); };
    for (const tok of tokens) {
      if (tok === "") continue;
      if (doc.widthOfString(cur + tok) <= width) { cur += tok; continue; }
      push(cur); cur = "";
      if (doc.widthOfString(tok) <= width) { cur = tok; continue; }
      let buf = "";
      for (const ch of tok) {
        if (doc.widthOfString(buf + ch) <= width) buf += ch;
        else { push(buf); buf = ch; }
      }
      cur = buf;
    }
    push(cur);
    return lines.length ? lines : [""];
  };

  // 段落：逐行流淌，跨页自然接上，不整段跳页
  const flowPara = (text, size = 10, font = "CJK", color = "#111111", gap = 6) => {
    const lines = wrapLines(text, font, size, CONTENT_W);
    const lineH = lineHOf(size);
    for (const line of lines) {
      if (doc.y + lineH > PAGE_H - MARGIN_BOTTOM) doc.addPage();
      doc.x = MARGIN_X;
      doc.font(font).fontSize(size).fillColor(color).text(line, MARGIN_X, doc.y, { width: CONTENT_W, lineBreak: false });
      doc.y += lineH;
    }
    doc.y += gap;
    doc.x = MARGIN_X;
  };

  // 章节条：藏青底白字。标题 + 至少 2 行内容塞不下，标题整段移到下一页，绝不孤悬页尾
  const sectionBar = (text) => {
    const BAR_H = 26;
    const need = BAR_H + 8 + 2 * lineHOf(10);
    if (doc.y + need > PAGE_H - MARGIN_BOTTOM) doc.addPage();
    const y = doc.y;
    doc.save().fillColor(NAVY).roundedRect(MARGIN_X, y, CONTENT_W, BAR_H, 4).fill().restore();
    doc.font("CJKBold").fontSize(13).fillColor("#FFFFFF").text(safeText(text), MARGIN_X + 12, y + 6, { width: CONTENT_W - 24, lineBreak: false });
    doc.y = y + BAR_H + 8;
    doc.x = MARGIN_X;
  };
  const subTitle = (text) => {
    if (doc.y + 20 + 2 * lineHOf(10) > PAGE_H - MARGIN_BOTTOM) doc.addPage();
    doc.x = MARGIN_X;
    doc.font("CJKBold").fontSize(10.5).fillColor("#333333").text(safeText(text), MARGIN_X, doc.y, { width: CONTENT_W });
    doc.y += 6;
    doc.x = MARGIN_X;
  };

  // 摘要框：浅蓝底框
  const summaryBox = (text) => {
    const padX = 12, padY = 10;
    const lines = wrapLines(text, "CJK", 10.5, CONTENT_W - padX * 2);
    const lineH = lineHOf(10.5);
    const boxH = padY * 2 + lines.length * lineH;
    if (doc.y + boxH > PAGE_H - MARGIN_BOTTOM) doc.addPage();
    const y = doc.y;
    doc.save().fillColor("#EAF2FB").strokeColor("#9DBFE8").lineWidth(1).roundedRect(MARGIN_X, y, CONTENT_W, boxH, 6).fillAndStroke().restore();
    let ly = y + padY;
    doc.font("CJK").fontSize(10.5).fillColor("#111111");
    for (const line of lines) {
      doc.text(line, MARGIN_X + padX, ly, { width: CONTENT_W - padX * 2, lineBreak: false });
      ly += lineH;
    }
    doc.y = y + boxH + 12;
    doc.x = MARGIN_X;
  };

  // 表格（整表原子 + 超长表按行断、表头重复；斑马纹，无单元格边框）
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
      if (doc.y + HEADER_H + 2 > PAGE_H - MARGIN_BOTTOM) doc.addPage();
      const y = doc.y;
      doc.save().fillColor("#F0F2F7").rect(MARGIN_X, y, CONTENT_W, HEADER_H).fill().restore();
      let x = MARGIN_X;
      doc.font("CJKBold").fontSize(9).fillColor(NAVY);
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

  // ── 封面：噜噜头像（圆形裁切）+ 标题 + 日期。不放副标题与元信息行 ──
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
  doc.font("CJKBold").fontSize(26).fillColor(NAVY).text(safeText("MyDesk 日报"), MARGIN_X, doc.y, { width: CONTENT_W, align: "center" });
  doc.y += 8;
  doc.x = MARGIN_X;
  doc.font("CJK").fontSize(11).fillColor("#333333").text(safeText(COVER_DATE_LINE), MARGIN_X, doc.y, { width: CONTENT_W, align: "center" });
  doc.y += 16;
  doc.x = MARGIN_X;

  // 摘要框
  summaryBox(SUMMARY);

  // 一、大盘
  sectionBar("一、大盘");
  flowPara("今天收盘：上证 3716.28（+0.24%）、深证成指 11802.46（-0.12%）、创业板 2772.38（-0.39%）、沪深 300 4170.61（+0.11%）。昨天上证收 3707.48。");
  drawTable(INDEX_TABLE);
  flowPara("上午一度大涨（11:30 时上证曾到 3742.66，+0.95%），下午回落，深证和创业板翻绿收盘——反弹没能续上。");
  drawTable(BREADTH_TABLE);
  flowPara("昨天是涨 435 / 跌 5125、中位 -3.04%，今天是反弹，但下午泄气。");

  // 二、板块资金
  sectionBar("二、板块资金：钱去了哪，钱从哪跑了");
  subTitle("钱去了这几个板块（净流入 Top5，行业）");
  drawTable(INFLOW_TABLE);
  subTitle("钱从这几个板块跑了（净流出 Top5，行业）");
  drawTable(OUTFLOW_TABLE);
  flowPara("概念榜也一样：半导体概念 +39.81 亿、军工 +37.23 亿、存储芯片 +36.36 亿、低空经济 +33.09 亿、无人机 +28.87 亿。");

  // 三、主线
  sectionBar("三、主线：军工 + 汽车 / 低空经济");
  flowPara("军工是最强主线：国防军工涨 +4.46%、吸金 29.34 亿，军工概念 +37.23 亿，军民融合 +24.59 亿。汽车和低空经济跟上：汽车 +2.13% / +28.07 亿，低空经济概念 +33.09 亿，无人机 +28.87 亿。");
  subTitle("主线龙头连续减持检查（近 30 天公告逐只核查）");
  drawTable(LEADER_REDUCE_TABLE);
  flowPara("主线龙头近 30 天 0 条减持公告，没有大股东连续减持。");

  // 四、分歧
  sectionBar("四、分歧：钱价打架");
  drawTable(DIVERGE_TABLE);
  flowPara("跌但钱在进（主力趁跌买）：昨晚美股芯片股还在跌（费城半导体指数 -0.88%，连跌 7 天），今天 A 股芯片是跌着但有钱接。");
  flowPara("涨但钱在跑（主力趁涨卖，别追高）：涨但钱跑的板块一共 182 个，大多是小幅流出，上面三个流出超 10 亿，最值得警惕。");
  flowPara("传媒最极端：板块流出最多（-36.84 亿），但龙头新华传媒还在 11 连板——龙头独涨、板块资金在跑，跟风要小心。");

  // 五、涨停板复盘
  sectionBar("五、涨停板复盘");
  drawTable(LIMITUP_TABLE);
  flowPara("新华传媒连板说明：库内日 K 起点 09-21 直接算是 10，加通达信延伸 30 根验证后为 11（10-13～10-15 停牌，停牌不中断连板）。");

  // 六、减持风险
  sectionBar("六、减持风险");
  flowPara("今天巨潮 998 条公告里减持 4 条，都是“计划到期、结果公布”，不是新出的要卖计划；且近 30 天每家都只有这一条减持公告，不算连续减持。");
  drawTable(REDUCE_TABLE);
  flowPara("主线龙头近 30 天无减持公告（见主线一节）。");

  // 七、AI 优选
  sectionBar("七、AI 优选：7 只票（10-15 选出，今天收盘对昨天收盘）");
  drawTable(AI_TABLE);
  flowPara("3 涨 4 跌，平均 -1.07%，跑输上证（+0.24%）和全市场中位（+0.46%）。上午 11:30 时平均还是 -0.63%，下午协和电子、舒华体育拖累扩大。");
  flowPara("AI 优选不是买入信号，仅供参考。");

  // 八、外围
  sectionBar("八、外围：昨晚美股（10-15 美东收盘）");
  drawTable(US_TABLE);
  flowPara("美股是涨的，但芯片股还在跌，AI 基建借钱投入的担心没散。");

  // 九、动态
  sectionBar("九、动态里提到的");
  flowPara("赣锋锂业三季报净利润同比 +19540.5%（动态提到）：但今天股价反而跌 -1.80%（40.01 → 39.29），成交额从 13.95 亿放到 24.87 亿——利好出来、放量下跌，别追。");
  flowPara("台积电 ADR 法说会后跌 3.40%，Q3 EPS 创历史新高（动态提到）。");

  // 十、下周一
  sectionBar("十、下周一（10-19）看什么");
  flowPara("· 军工能不能继续吸金：今天最强主线，断了就是假动作。");
  flowPara("· 半导体“跌但钱进”能不能变成“涨且钱进”：钱和价同向了才算稳住。");
  flowPara("· 新华传媒 11 连板封不封得住：炸板就说明短线情绪在退潮。");
  flowPara("· 协和电子这种 AI 票下午加速跌，说明选股还在亏钱，别因为“AI 选的”就拿着。");

  // 数据口径（附录，封面不放元信息）
  sectionBar("数据口径");
  flowPara("收盘价来自通达信日 K（15:00 后入库，5576 只，B 股已剔）；指数经通达信与东财双向核对一致；板块资金来自东财延迟镜像收盘榜（主力净额 = 超大单 + 大单净流入）；减持来自巨潮今日 998 条公告现拉 + 主线龙头近 30 天公告逐只核查；炸板率当日无盘中触板数据，未取到。");

  // ── 页脚：手动居中，不传 width/align，避免 PDFKit 流式换行产生空白页 ──
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const footer = `MyDesk 日报 · 第 ${i + 1} 页`;
    doc.font("CJK").fontSize(8.5).fillColor(GRAY);
    const tw = doc.widthOfString(safeText(footer));
    doc.text(safeText(footer), (PAGE_W - tw) / 2, PAGE_H - 32, { lineBreak: false });
  }

  doc.end();
  const buf = await done;
  fs.writeFileSync(outPath, buf);
  console.log(`写出 ${outPath}，${buf.length} 字节，${range.count} 页`);
}

main().catch((e) => { console.error(e); process.exit(1); });
