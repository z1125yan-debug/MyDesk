// 重新生成第一版午盘 PDF（2026-10-16），只修分页，其他原样。
// 第一版：MyDesk日报-2026-10-16午盘.pdf（7 页，用户说“做得还行”）
// 本脚本：内容/样式/封面与第一版一致，只修：
//   1. 表格整表原子（能塞一页的表，空间不够时整张移到下一页，不从中间劈开；超长表按行断，表头重复）
//   2. AI 卡整卡原子（能塞一页的卡，空间不够时整张移到下一页）
//   3. 页脚 bug（手动居中，不传 width/align，不产生空白页脚页）
// 不加 Z 徽标，不换早报/午报，不改其他样式。
// 用法：node scripts/generate-midday-v1-fixed.js [输出路径]

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
const LIGHT_LINE = "#DDDDDD";

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
      // UTF-16BE
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
/** 从 TTC 集合里抽出第 index 个字体，重建成单个 TTF（与 daily-report-pdf.ts 相同逻辑）。 */
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

// --- 第一版内容（逐字取自第一版 PDF，原样）---
const COVER = {
  title: "MyDesk 日报",
  subtitle: "主线 · AI 优选 · 风险 · 涨停龙头",
  dateLine: "2026 年 10 月 16 日（周五）· 午盘日报",
  meta: "生成时间 2026-10-16 09:56（北京时间）· 数据来源：通达信网关 + 本地库 + 同花顺 + 巨潮 + 长桥 MCP · 缺数据写“未取到”，不编",
};

const SUMMARY = "一句话总结：昨天（10-15）大跌，5125 只跌，只有 435 只涨，弱势。今天（10-16）上午反弹，上证涨 0.59%，军工装备最强（涨 4.14%，钱流入 12.31 亿）。但半导体涨了 0.78%，钱却跑了 20.01 亿——涨了但主力在卖，别追。AI 选的 7 只票今天上午 3 涨 4 跌，跑输大盘，协和电子跌 5.40% 最多。";

const MORNING_TABLE = {
  headers: ["指数", "现在", "涨跌", "今开 / 最高 / 最低"],
  widths: [1.2, 1, 0.8, 2],
  rows: [
    ["上证指数", "3729.38", "+0.59%", "3723.80 / 3737.23 / 3716.46"],
    ["沪深 300", "4183.05", "+0.41%", "4189.26 / 4193.52 / 4175.97"],
    ["创业板指", "2793.76", "+0.38%", "2831.88 / 2832.12 / 2791.66"],
    ["科创 50", "1372.21", "+0.93%", "1381.93 / 1383.85 / 1363.11"],
    ["上证 50", "2774.23", "+0.33%", "—"],
  ],
};
const YESTERDAY_TABLE = {
  headers: ["指标", "数值"],
  widths: [1.2, 2.8],
  rows: [
    ["上证收盘", "3707.48（跌 1.59%）"],
    ["全 A 总数", "5567 只"],
    ["涨/跌/平", "涨 435 只 / 跌 5125 只 / 平 4 只"],
    ["中位涨跌", "-3.04%（一半的票跌超过 3%）"],
    ["涨停 / 跌停", "涨停 37 只 / 跌停 60 只"],
    ["站上 5 日线", "9.04%（10-09 还是 54.24%，5 天掉了 45 个点）"],
    ["当日情绪档位", "弱势（上证收在 MA20 3858.64 下面，且 MA20 向下）"],
    ["见顶压力分", "55.2 / 100（偏高：炸板与涨跌停 85.6、接力 71.4、宽度骤降 75.2）"],
  ],
};
const INFLOW_TABLE = {
  headers: ["板块", "涨跌", "净流入"],
  widths: [1.2, 1, 1.2],
  rows: [
    ["军工装备", "+4.14%", "+12.31 亿"],
    ["银行", "+0.67%", "+11.11 亿"],
    ["电力", "+1.18%", "+6.35 亿"],
    ["白酒", "+1.12%", "+4.51 亿"],
    ["化学制药", "+1.63%", "+4.06 亿"],
  ],
};
const OUTFLOW_TABLE = {
  headers: ["板块", "涨跌", "净流出", "怎么看"],
  widths: [1, 0.8, 1, 1.6],
  rows: [
    ["半导体", "+0.78%", "-20.01 亿", "涨了但钱在跑，分歧，小心"],
    ["元件", "-1.20%", "-15.66 亿", "跌 + 钱跑，一致看空"],
    ["电池", "-0.58%", "-7.32 亿", "跌 + 钱跑，一致看空"],
    ["通信设备", "+1.58%", "-5.07 亿", "涨了但钱在跑，分歧"],
    ["软件开发", "+1.14%", "-5.06 亿", "涨了但钱在跑，分歧"],
  ],
};
const LADDER_TABLE = {
  headers: ["梯队", "只数"],
  widths: [1.5, 1.5],
  rows: [
    ["1板", "30 只"],
    ["2板", "2只"],
    ["3板", "2只"],
    ["5 板（最高）", "2只"],
    ["断层", "4 板断层（没有 4 板的票）"],
  ],
};
const REDUCE_TABLE = {
  headers: ["代码", "名称", "谁在减", "阶段"],
  widths: [0.9, 1.1, 1.4, 1.6],
  rows: [
    ["601360", "三六零", "控股股东", "计划届满暨结果（已卖）"],
    ["002884", "凌霄泵业", "高级管理人员", "实施完成（已卖）"],
    ["002196", "方正电机", "董事及高管", "计划届满暨完成（已卖）"],
    ["002028", "思源电气", "董事兼高管", "期限届满暨实施情况（已卖）"],
  ],
};
const US_TABLE = {
  headers: ["美股", "收盘", "涨跌"],
  widths: [2, 1, 1],
  rows: [
    ["标普 500 ETF（SPY）", "771.79", "+0.28%"],
    ["纳指 100 ETF（QQQ）", "728.00", "-0.13%"],
    ["标普 500 ETF（VOO）", "709.43", "+0.28%"],
    ["道指 ETF（DIA）", "521.18", "+1.08%"],
    ["英伟达（NVDA）", "217.23", "-1.84%"],
  ],
};
const AI_CARDS = [
  {
    title: "600276 恒瑞医药 · 今天上午 +0.99%（47.06 元，昨天收 46.60）",
    fields: [
      ["入选理由", "弱市里唯一量价与资金双强的大市值医药，主力净额 +2.12 亿且外资持股比例获上调，防御属性和产业逻辑同时成立。"],
      ["入场条件", "缩量回踩不破近端均线、或放量站上当日高点后再关注。"],
      ["仓位节奏", "分批。"],
      ["失效条件", "主力资金转为大幅净流出或外资持股变动被证伪。"],
      ["主要风险", "PE 40.03 估值不低，弱市大盘系统性下杀时补跌。"],
      ["依据", "涨 2.44%、成交额 29.47 亿、主力净额 +2.12 亿、换手 1.00%、PE 40.03、PB 4.80。"],
      ["反证状态", "若次日缩量阴线且主力转净流出，说明外资增配被市场无视，判断错误。"],
      ["操作参考", "关注。"],
    ],
  },
  {
    title: "605258 协和电子 · 今天上午 -5.40%（40.13 元，昨天收 42.42）⚠️ 今天跌最多",
    fields: [
      ["入选理由", "小市值 PCB 标的，底分型叠加 PCB / 先进封装产业催化，换手 14.45% 显示资金真金白银在博弈。"],
      ["入场条件", "回踩不破当日实体一半并放量回升再关注。"],
      ["仓位节奏", "轻仓。"],
      ["失效条件", "PCB 板块催化无后续跟进、成交骤降且主力转净流出。"],
      ["主要风险", "PE 56.56、市值仅 37.3 亿，波动剧烈，超短资金一旦撤离回撤快。"],
      ["反证状态", "若次日高开低走放巨量收阴，说明是情绪脉冲而非趋势启动。"],
      ["操作参考", "关注（今天跌 5.40%，先别追）。"],
    ],
  },
  {
    title: "300771 智莱科技 · 今天上午 -0.85%（11.63 元，昨天收 11.73）",
    fields: [
      ["入选理由", "市值仅 28.2 亿、PB 1.42 的低估值计算机设备股，涨 5.49% 伴随主力净流入 +0.16 亿。"],
      ["仓位节奏", "轻仓。"],
      ["主要风险", "小市值，波动大。"],
      ["操作参考", "关注。"],
    ],
  },
  {
    title: "603198 迎驾贡酒 · 今天上午 +1.37%（39.13 元，昨天收 38.60）",
    fields: [
      ["入选理由", "多信号共振（MACD 金叉 + KDJ 金叉），PE 15.31 在白酒里相对低，估值和信号都有。"],
      ["入场条件", "放量收复长上影线高点区域后再关注，上影线收复前等待。"],
      ["失效条件", "MACD / KDJ 金叉反转，或长上影线 3 天收不回来。"],
      ["主要风险", "当天收长上影线，上方抛压重，涨幅只有 0.29%，上攻力度不足。"],
      ["操作参考", "等待（信号确认前不参与）。"],
    ],
  },
  {
    title: "605299 舒华体育 · 今天上午 -3.08%（12.58 元，昨天收 12.98）",
    fields: [
      ["入选理由", "换手 8.47%，主力净流入 +0.18 亿，机构龙虎榜解读（数据中心制冷 + 冰雪产业概念）。"],
      ["仓位节奏", "轻仓。"],
      ["主要风险", "概念新闻是别的公司的标题，概念热度不等于这只票的利好。"],
      ["操作参考", "关注（今天跌 3.08%，先别追）。"],
    ],
  },
  {
    title: "603919 金徽酒 · 今天上午 -0.71%（16.70 元，昨天收 16.82）",
    fields: [
      ["入选理由", "换手 4.18%，白酒概念震荡上行。"],
      ["主要风险", "主力净流出 -0.10 亿，资金不配合；新闻只有板块级，没有这只票自己的催化。"],
      ["操作参考", "关注（资金不配合，小心）。"],
    ],
  },
  {
    title: "601001 晋控煤业 · 今天上午 +0.17%（17.78 元，昨天收 17.75）",
    fields: [
      ["入选理由", "低估值（PE 17.70、PB 1.55）+ 低价 + 昨天只跌 1.39%（比中位 -3.04% 抗跌），弱市里相对抗跌的防御型底分型。"],
      ["入场条件", "放量站上近端均线且煤炭板块同步走强后再关注。"],
      ["仓位节奏", "先等，确认后再分批。"],
      ["失效条件", "跌破底分型低点且市场继续缩量下跌，或动力煤价格预期走弱。"],
      ["主要风险", "弱势系统性回落还没结束，煤炭是周期股，需求预期变化会放大波动。主力净额 +0.00 亿（实际 +0.002 亿，基本为零），不是主力在流入。"],
      ["操作参考", "关注（等优先）。"],
    ],
  },
];

// --- 渲染 ---
async function main() {
  const outPath = process.argv[2] || path.join(process.env.HOME, "workspace/your_files/MyDesk日报-2026-10-16午盘-分页修复.pdf");
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
  const ensureSpace = (h) => { if (doc.y + h > PAGE_H - MARGIN_BOTTOM) doc.addPage(); };

  // 段落高度（用于原子判定）
  const paraHeight = (text, size, font) => {
    doc.font(font).fontSize(size);
    return doc.heightOfString(safeText(text), { width: CONTENT_W }) + 2;
  };

  // 段落（普通正文，允许跨页，但不从段落中间劈——先算高度，不够则整段移到下一页；超长段落按自然换行）
  const para = (text, size = 10, font = "CJK", color = "#111111", gap = 6) => {
    const h = paraHeight(text, size, font);
    if (h <= usableFull && doc.y + h > PAGE_H - MARGIN_BOTTOM) doc.addPage();
    doc.x = MARGIN_X;
    doc.font(font).fontSize(size).fillColor(color).text(safeText(text), MARGIN_X, doc.y, { width: CONTENT_W });
    doc.y += gap;
    doc.x = MARGIN_X;
  };

  // 小节标题
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

  // 表格（整表原子 + 超长表按行断、表头重复）
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

  // AI 卡（整卡原子）
  const drawAiCard = (card) => {
    // 先算整卡高度
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

  // ── 封面：噜噜头像（圆形裁切）+ 标题 + 日期。去噪：副标题与元信息行不放封面（数据来源已在文末“数据日期说明”里）。──
  const AVATAR_PNG = path.join(__dirname, "avatar-lulu-cover.png"); // 由噜噜头像 webp 转出的正方形 PNG
  const AV_SIZE = 96;
  const avX = (PAGE_W - AV_SIZE) / 2;
  const avY = doc.y;
  doc.save();
  doc.circle(avX + AV_SIZE / 2, avY + AV_SIZE / 2, AV_SIZE / 2).clip();
  doc.image(AVATAR_PNG, avX, avY, { width: AV_SIZE, height: AV_SIZE });
  doc.restore();
  doc.y = avY + AV_SIZE + 14;
  doc.x = MARGIN_X;
  doc.font("CJKBold").fontSize(26).fillColor(NAVY).text(safeText(COVER.title), MARGIN_X, doc.y, { width: CONTENT_W, align: "center" });
  doc.y += 8;
  doc.x = MARGIN_X;
  doc.font("CJK").fontSize(11).fillColor("#333333").text(safeText(COVER.dateLine), MARGIN_X, doc.y, { width: CONTENT_W, align: "center" });
  doc.y += 16;
  doc.x = MARGIN_X;

  // 一句话总结
  para(SUMMARY, 10.5, "CJK", "#111111", 12);

  // 一、大盘
  sectionTitle("一、大盘");
  subTitle("今天上午（2026-10-16，截至约 09:47，盘中，不是收盘）");
  drawTable(MORNING_TABLE);
  para("今天上午是反弹，四大指数都涨，科创 50 涨得最多（+0.93%）。但这只是上午盘，下午还可能变，别把上午的涨当成全天的。");
  subTitle("昨天（2026-10-15，收盘）");
  drawTable(YESTERDAY_TABLE);

  // 二、主线
  sectionTitle("二、主线：今天最强的板块");
  para("主线是军工装备：今天涨 4.14%，钱净流入 12.31 亿（流入 44.41 亿，流出 32.09 亿）。板块里 82 家公司，领涨的是晟楠科技（涨 26.21%）。钱和价格方向一致，没有打架。");
  para("第二梯队：银行（涨 0.67%，流入 11.11 亿）、电力（涨 1.18%，流入 6.35 亿）、白酒（涨 1.12%，流入 4.51 亿）、化学制药（涨 1.63%，流入 4.06 亿）。");
  para("主线里的票有没有大股东连续减持？今天主线板块里没查到大股东连续减持（按 30 天内同一家公司 ≥2 次减持公告算）。");

  // 三、板块资金
  sectionTitle("三、板块资金：钱去了哪，钱从哪跑了");
  subTitle("钱去了这几个板块（净流入 Top5，2026-10-16 上午盘中）");
  drawTable(INFLOW_TABLE);
  subTitle("钱从这几个板块跑了（净流出 Top5）");
  drawTable(OUTFLOW_TABLE);

  // 四、分歧
  sectionTitle("四、分歧：哪里在打架");
  para("⚠️ 半导体：资金与价格打架。今天半导体涨 0.78%，但钱净流出 20.01 亿。价格在涨，钱在跑——可能是主力在趁涨卖出，别只看涨就追高。等钱回流了再看。");
  para("⚠️ 文化传媒：资金与价格打架。今天涨 3.00%，但钱净流出 1.99 亿。涨了但主力在卖，小心。");
  para("龙头 vs 小票：昨天（10-15）全 A 5125 只跌，只有 435 只涨，连龙头也跌，是一致看空，不是龙头独强。今天上午军工装备龙头晟楠科技涨 26.21%，板块涨 4.14%，龙头和板块一起涨，方向一致，还没出现龙头独涨、小票普跌的抱团分歧。");
  para("指数 vs 个股：昨天上证跌 1.59%，但中位跌 3.04%——指数跌得比大多数票少，是因为大票扛着，小票跌得更狠。今天上午上证涨 0.59%，AI 选的 7 只票平均跌 1.07%，跑输指数，个股比指数弱。");

  // 五、涨停板复盘
  sectionTitle("五、涨停板复盘（昨天 2026-10-15 收盘）");
  drawTable(LADDER_TABLE);
  para("龙头（5 板 2 只）：002343 慈文传媒（5 板）、002696 百洋股份（5 板）。");
  para("接力：昨天 48 只涨停的票，今天（10-15→10-16 是不同口径，这里是 10-14→10-15）1 进 2 只有 2/34（5.9%），接力很弱，追涨停接不上。");
  para("注：接力数据为 10-14→10-15 口径（1 进 2：2/34，2 进 3：2/9，3 板以上续住 2/5）。");

  // 六、减持风险
  sectionTitle("六、减持风险");
  subTitle("今天（2026-10-16，截至 09:56，巨潮公告，不完整，盘中还会新增）");
  para("减持公告 4 条：1 只控股股东 + 3 只董监高，全部是“计划届满 / 实施完成”（已经卖了或计划到期），不是新出的减持计划。");
  drawTable(REDUCE_TABLE);
  subTitle("昨天（2026-10-15，全天）");
  para("减持公告 16 条，其中大股东（控股股东 + 持股 5% 以上）10 只，分散在 10 个不同板块，没有集中在某一个板块，不是某个板块的大股东集体在卖。");

  // 七、AI 优选
  sectionTitle("七、AI 优选：7 只票（10-15 选出，今天上午表现）");
  para("AI 从 11 只候选里优选出 7 只（模型 deepseek-v4.1-flash，弱势档，见顶压力分 55.2）。今天上午（截至约 09:47，盘中）7 只票平均 -1.07%，跑输上证（+0.59%）。3 涨 4 跌。");
  for (const card of AI_CARDS) drawAiCard(card);

  // 八、美股
  sectionTitle("八、美股（2026-10-15 收盘，美股凌晨 4:00 已收盘）");
  drawTable(US_TABLE);
  para("美股昨晚涨了，A 股今天上午高开（上证开 3723.80，比昨天收 3707.48 高开 0.44%）。纳指和标普方向不一样（纳指跌 0.13%，标普涨 0.28%），科技股和大盘走得不一样。英伟达跌了 1.84%，A 股半导体今天上午涨 0.78% 但钱跑了 20.01 亿，半导体确实弱。");

  // 九、美联储
  sectionTitle("九、美联储 / 预测市场");
  para("下次 FOMC 会议是 10 月 28 日。10 月 28 日会议：加息概率 28.9%（Kalshi 30.0%，Polymarket 27.9%，取平均），按兵不动概率 71.1%，市场觉得更可能按兵不动。");
  para("12 月会议：加息概率 81.4%（Kalshi 81.0%，Polymarket 81.8%，取平均），按兵不动概率 18.6%，市场觉得更可能加息。");
  para("10 月会议更可能按兵不动：钱的价格不变，对 A 股偏中性，不用因为美联储慌。12 月会议的加息预期比 10 月更热（81.4% vs 28.9%），12 月会议前后 A 股要小心一点：真加息就是钱变贵，股市可能跌。");
  para("动态相关：今天动态里看了 5 条，和股票相关的有 1 条：《10月28日FOMC：加息，还是按兵不动？》——截至 10 月 15 日晚，Kalshi 与 Polymarket 的平均价格显示，10 月 28 日会议更可能维持利率。同一口径下，12 月会议的加息预期明显更热。（2026-10-15，来源：动态）");

  // 十、今天下午看什么
  sectionTitle("十、今天下午看什么");
  para("· 军工装备能不能守住：上午最强（涨 4.14%，流入 12.31 亿），下午如果还流入、还涨，说明主线成立；如果下午钱跑了、涨幅回落，说明上午是脉冲。");
  para("· 半导体能不能止血：上午涨 0.78% 但钱跑了 20.01 亿，下午如果钱还跑，别碰半导体；如果钱回流了，再看。");
  para("· AI 选的 7 只票：上午 3 涨 4 跌，协和电子跌 5.40%、舒华跌 3.08%，下午别追跌的，等止跌。");
  para("· 大盘能不能站稳：上证上午最高 3737.23，下午如果跌破 3716.46（上午最低），说明反弹弱了。");

  // 数据日期说明
  sectionTitle("数据日期说明（上海时区，和交易日对齐）");
  para("- A 股指数 / AI 选票今天上午：2026-10-16 盘中（截至约 09:47），不是收盘，下午还会变。");
  para("- A 股昨天：2026-10-15 收盘（全 A 5567、涨跌家数、涨停/跌停、档位弱势、压力分 55.2、AI 优选 7 只）。");
  para("- 板块资金 / 主线 / 分歧：2026-10-16 上午盘中（同花顺行业资金榜，行本身不带日期，按未开盘前取到的是昨天收盘冻结值判断；今天已开盘，取到的是今天上午盘中值）。");
  para("- 减持：今天 2026-10-16 截至 09:56（盘中，还会新增）；昨天 2026-10-15 全天。");
  para("- 美股：2026-10-15 收盘（美股凌晨 4:00 已收盘）。");
  para("- 美联储 / 预测市场：2026-10-16 上午拉取（Kalshi + Polymarket 平均）。");
  para("- 缺数据写“未取到”，不编。AI 优选不是买入信号，仅供参考。");

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
  console.log(`写出 ${outPath}，${buf.length} 字节`);
  // 页数
  const { execSync } = require("child_process");
  try {
    const info = execSync(`pdfinfo "${outPath}" 2>/dev/null | grep Pages`, { encoding: "utf8" });
    console.log(info.trim());
  } catch { /* pdfinfo 不可用时跳过 */ }
}

main().catch((e) => { console.error(e); process.exit(1); });
