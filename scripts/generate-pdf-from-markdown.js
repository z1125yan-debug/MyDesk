// 从已归档的日报 markdown 生成第一版样式 PDF（不重拉数据、不重算、不编数字）。
//
// 用法：
//   node scripts/generate-pdf-from-markdown.js <md路径> <输出PDF路径> <封面日期行>
// 例如：
//   node scripts/generate-pdf-from-markdown.js \
//     ~/workspace/goals/mydesk-market-data-and-stock-picking-workflow/hidden_files/evening-report-2026-10-16.md \
//     ~/workspace/your_files/MyDesk日报-2026-10-16晚报.pdf \
//     "2026 年 10 月 16 日（周五）· 晚报"
//
// 解析规则（只做排版转换，不改内容）：
//   · `# 标题` 行丢弃（封面已有“ MyDesk 日报” + 日期行）；
//   · 第一个 `## ` 之前的正文 → 封面后的说明段（如“数据口径”）；
//   · `## 小节` → 一节，自动加中文序号（一、二、…）；
//   · `- ` 开头的行 → “· ”项目符号段落；其余非空行 → 普通段落；
//   · `**` 加粗标记去掉（PDF 里不画加粗段内标记）。

const fs = require("fs");
const { renderV1Pdf } = require("./daily-pdf-v1");

const NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五"];

function clean(s) {
  return String(s ?? "").replace(/\*\*/g, "").trim();
}

function parseMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const preambleParts = [];
  const sections = [];
  let current = null;
  let seenSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === "---") continue;
    if (line.startsWith("# ")) continue; // 主标题丢弃
    if (line.startsWith("## ")) {
      seenSection = true;
      current = { heading: clean(line.slice(3)), blocks: [] };
      sections.push(current);
      continue;
    }
    if (!seenSection) {
      preambleParts.push(clean(line));
      continue;
    }
    if (!current) continue;
    if (line.startsWith("- ")) {
      current.blocks.push({ kind: "para", text: `· ${clean(line.slice(2))}` });
    } else {
      current.blocks.push({ kind: "para", text: clean(line) });
    }
  }
  const numbered = sections.map((s, i) => ({
    heading: `${NUMERALS[i] ?? `${i + 1}`}、${s.heading}`,
    blocks: s.blocks,
  }));
  return { preamble: preambleParts.join(" "), sections: numbered };
}

async function main() {
  const [mdPath, outPath, coverDateLine] = process.argv.slice(2);
  if (!mdPath || !outPath || !coverDateLine) {
    console.error("用法：node scripts/generate-pdf-from-markdown.js <md路径> <输出PDF路径> <封面日期行>");
    process.exit(1);
  }
  const md = fs.readFileSync(mdPath, "utf8");
  const { preamble, sections } = parseMarkdown(md);
  if (!sections.length) throw new Error(`没有解析出任何小节：${mdPath}`);
  const res = await renderV1Pdf({ outPath, coverDateLine, preamble, sections, appendix: null });
  console.log(`写出 ${res.outPath}，${res.bytes} 字节，${res.pages} 页`);
}

main().catch((e) => { console.error(e); process.exit(1); });
