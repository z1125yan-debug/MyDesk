// MyDesk AI优选战绩总览 PDF 生成器 v2（pdfkit；段落用 heightOfString 实测行高，避免重叠）
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import * as fontkit from "fontkit";

const HOME = process.env.HOME;
const REPO = path.join(HOME, "workspace/kairotrend-p1");
const GOAL_FILES = path.join(HOME, "workspace/goals/mydesk-market-data-and-stock-picking-workflow/files");
const OUT = path.join(GOAL_FILES, "AI优选战绩总览-2026-10-22.pdf");
const AVATAR = path.join(REPO, "scripts/avatar-lulu-cover.png");

const FONT_CANDIDATES = ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"];
const FONT_BOLD_CANDIDATES = ["/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc"];
function loadFont(candidates) {
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const coll = fontkit.create(fs.readFileSync(p));
      const fonts = coll.fonts || [coll];
      return fonts.find((f) => /SC\b/i.test(f.fullName || "")) || fonts[0];
    } catch { /* next */ }
  }
  return null;
}
const RED = "#c0392b", GREEN = "#1e8449", DARK = "#1c1c1e", GRAY = "#6b6b70", LINE = "#d9d9de", BG = "#f0f0f3";

const batches = [
  { d: "2026-10-15", sell: "2026-10-19", sse: "+0.39%", avg: -1.26, wl: "2 胜 5 负", note: null,
    rows: [["迎驾贡酒", "603198", 6.02, true], ["金徽酒", "603919", 1.29, true], ["协和电子", "605258", 0.22, false], ["恒瑞医药", "600276", -0.78, false], ["晋控煤业", "601001", -1.08, false], ["智莱科技", "300771", -3.90, false], ["舒华体育", "605299", -10.57, false]] },
  { d: "2026-10-16", sell: "2026-10-20", sse: "+0.12%", avg: 3.59, wl: "5 胜 2 负", note: "四批中唯一像样的一批——军工方向站对了风口。",
    rows: [["锐科激光", "300747", 7.83, true], ["北方导航", "600435", 7.32, true], ["国科军工", "688543", 6.66, true], ["安徽合力", "600761", 2.99, true], ["航发动力", "600893", 1.48, true], ["健友股份", "603707", -0.04, false], ["中直股份", "600038", -1.10, false]] },
  { d: "2026-10-19", sell: "2026-10-21", sse: "-0.15%", avg: -1.38, wl: "1 胜 6 负", note: "民生银行、沪农商行于选股当日傍晚被王文灵双开事件命中；双口径：剔除两只银行后平均 -1.05%，1 胜 4 负。",
    rows: [["航发动力", "600893", 0.40, true], ["航发控制", "000738", -0.36, false], ["仙琚制药", "002332", -0.75, false], ["中航机载", "600372", -1.11, false], ["沪农商行", "601825", -2.02, false], ["民生银行", "600016", -2.39, false], ["国网信通", "600131", -3.42, false]] },
  { d: "2026-10-20", sell: "2026-10-22", sse: "-2.21%", avg: -3.38, wl: "3 胜 4 负", note: "本批为初算（15:05 收盘快照按正式公式核算，16:15 台账落定为准）。5 只机器人/题材链小票决策日同日齐涨，卖出日板块退潮同沉，为四批最差。",
    rows: [["德马科技", "688360", 1.59, true], ["龙旗科技", "603341", 1.18, true], ["斯菱智驱", "301550", -1.74, true], ["阿尔特", "300825", -3.60, false], ["华建集团", "600629", -5.84, false], ["日出东方", "603366", -6.42, false], ["和仁科技", "300550", -8.81, false]] },
];

const regular = loadFont(FONT_CANDIDATES);
if (!regular) throw new Error("找不到中文字体");
const bold = loadFont(FONT_BOLD_CANDIDATES) || regular;

const doc = new PDFDocument({ size: "A4", margins: { top: 44, bottom: 44, left: 48, right: 48 } });
doc.registerFont("regular", regular);
doc.registerFont("bold", bold);
doc.pipe(fs.createWriteStream(OUT));
const X0 = 48, W = doc.page.width - 96, BOTTOM = doc.page.height - 48;
let y = 44;
const pct = (v) => (v > 0 ? "+" : "") + v.toFixed(2) + "%";
function para(t, size, font, color, after = 6, x = X0, width = W) {
  doc.font(font).fontSize(size);
  const h = doc.heightOfString(t, { width, lineGap: 2 });
  if (y + h > BOTTOM) { doc.addPage(); y = 44; }
  doc.fillColor(color).text(t, x, y, { width, lineGap: 2 });
  y += h + after;
}
function heading(t, size = 14) { if (y + size + 14 > BOTTOM) { doc.addPage(); y = 44; } para(t, size, "bold", DARK, 8); }

// 头部
if (fs.existsSync(AVATAR)) doc.image(AVATAR, X0, y, { width: 54, height: 54 });
doc.font("bold").fontSize(21).fillColor(DARK).text("MyDesk AI 优选战绩总览", X0 + 66, y + 2, { width: W - 66 });
doc.font("regular").fontSize(10.5).fillColor(GRAY).text("截至 2026-10-22 · 已结算 4 批 · 共 28 只", X0 + 66, y + 34, { width: W - 66 });
y += 68;
doc.moveTo(X0, y).lineTo(X0 + W, y).strokeColor(LINE).lineWidth(1).stroke(); y += 12;

para("口径：决策日收盘后选股 → 次交易日开盘买入 → 第三交易日收盘卖出；净收益 = 卖出价 / 买入开盘价 − 1 − 0.41%（成本）；「胜」= 净收益跑赢上证同期（上证以买入日开盘为基准的毛涨幅）。停牌剔除。数据来源：MyDesk 快照与日K（TDX 源），缺失留空、不补造。", 9.5, "regular", GRAY, 10);

// 总览表
heading("总览");
const c1 = X0, c2 = X0 + 168, c3 = X0 + 268, c4 = X0 + 388;
doc.font("bold").fontSize(10).fillColor(GRAY);
doc.text("决策日 → 卖出日", c1, y, { width: 168 });
doc.text("平均净收益", c2, y, { width: 100 });
doc.text("胜负（跑赢上证）", c3, y, { width: 120 });
doc.text("上证同期", c4, y, { width: 100 });
y += 18;
doc.moveTo(X0, y).lineTo(X0 + W, y).strokeColor(LINE).stroke(); y += 7;
for (const b of batches) {
  doc.font("regular").fontSize(10.5).fillColor(DARK).text(`${b.d} → ${b.sell}`, c1, y, { width: 168 });
  doc.font("bold").fontSize(10.5).fillColor(b.avg >= 0 ? RED : GREEN).text(pct(b.avg), c2, y, { width: 100 });
  doc.font("regular").fontSize(10.5).fillColor(DARK).text(b.wl, c3, y, { width: 120 });
  doc.font("regular").fontSize(10.5).fillColor(DARK).text(b.sse, c4, y, { width: 100 });
  y += 20;
}
const sumText = "四批合计：批次平均 -0.61% · 11 胜 17 负 · 净收益为正 11/28 只 · 最大赢家 锐科激光 +7.83% · 最大输家 舒华体育 -10.57%";
doc.font("bold").fontSize(10.5);
const sumH = doc.heightOfString(sumText, { width: W - 16, lineGap: 2 }) + 14;
if (y + sumH > BOTTOM) { doc.addPage(); y = 44; }
doc.rect(X0, y, W, sumH).fillColor(BG).fill();
doc.fillColor(DARK).text(sumText, X0 + 8, y + 7, { width: W - 16, lineGap: 2 });
y += sumH + 14;

// 逐批明细
for (const [bi, b] of batches.entries()) {
  heading(`第 ${bi + 1} 批 · 决策日 ${b.d} → 卖出日 ${b.sell}（上证同期 ${b.sse}）`, 12.5);
  para(`平均净收益 ${pct(b.avg)} · ${b.wl}`, 10, "bold", b.avg >= 0 ? RED : GREEN, 5);
  for (const [name, code, v, win] of b.rows) {
    if (y + 17 > BOTTOM) { doc.addPage(); y = 44; }
    doc.font("regular").fontSize(10.5).fillColor(DARK).text(`${name}（${code}）`, X0 + 12, y, { width: 250 });
    doc.font("bold").fontSize(10.5).fillColor(v >= 0 ? RED : GREEN).text(pct(v), X0 + 290, y, { width: 80 });
    if (win) doc.font("regular").fontSize(10).fillColor(RED).text("胜", X0 + 380, y, { width: 30 });
    y += 17;
  }
  if (b.note) para("注：" + b.note, 9, "regular", GRAY, 6, X0 + 12, W - 12);
  y += 8;
}

// 未结算
heading("未结算");
para("第 5 批 · 决策日 2026-10-21（晶晨股份、雪人集团、新华百货、九牧王、鸥玛软件）：2026-10-22 开盘买入，2026-10-23 卖出。", 10, "regular", DARK, 3);
para("第 6 批 · 决策日 2026-10-22：今日 15:45 生成，2026-10-23 开盘买入，2026-10-26 卖出。", 10, "regular", DARK, 10);

// 观察与待评审
heading("深亏票观察（2026-10-22 复盘，假设级 · 样本 28 只）");
const obs = [
  "候选池结构性偏动量：27/28 只决策日当天上涨（中位 +3.3%）——候选来自当日第一层强势筛选，回调票进不了池。",
  "深亏组（≤-3.4%，7 只）决策日多呈「一致性高潮」：涨幅中位 +8.7%、量比（对 20 日均量）中位 2.84、上影占比中位仅 10%（盈利组 36%）——大涨 + 放量 + 收在最高点附近。",
  "对照：德马科技缩量涨停（量比 0.77）最终 +1.59%；日出东方放量涨停（量比 2.86）最终 -6.42%。判别须涨幅、量比、收盘位置合看。",
  "批次内相关性：第 4 批 5 只同题材链同日齐涨、同日同沉；现有风险标签 A（冲高回落）对「封死高潮」形态存在盲区。",
];
for (const o of obs) para("· " + o, 9.8, "regular", DARK, 4);
para("待评审提案（2026-10-22 已记录，代码未动，20 个交易日战绩攒满后一并评审）：① 标签 D「一致性高潮」只标注不拦截 + 批次同主题集中标注；② 回调通道纸面并行（近 5 日涨 ≥8% + 当日跌 2–6% + 缩量 + 不破 MA10，独立记账对照）。同期一并评审：量能水位闸门、板块定性（跷跷板盲区）、隔夜突发利空跳过规则。", 9.8, "regular", DARK, 4);
para("生成时间：2026-10-22 15:30（Asia/Shanghai）。本文件为纸面选股战绩记录，与实盘台账严格隔离。", 8.5, "regular", GRAY, 0);

doc.end();
console.log("PDF written:", OUT);
