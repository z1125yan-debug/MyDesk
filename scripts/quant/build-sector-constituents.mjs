// scripts/quant/build-sector-constituents.mjs
// Phase 0① 板块成分映射（含市值）：
//   读 data/industry-map.json（code -> 申万行业名），反向建 行业 -> 成分股，
//   调腾讯 qt.gtimg.cn 批量补每只 总市值/名称/涨跌幅，落档 data/sector-constituents.json。
// 避东财断源；不猜，缺市值显 null 并在统计里剔除（页面如实显示覆盖不足）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const MAP_PATH = path.join(ROOT, "data", "industry-map.json");
const OUT_PATH = path.join(ROOT, "data", "sector-constituents.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BATCH = 60; // 腾讯批量报价单次上限
const CONC = 6; // 并发批数
const TIMEOUT = 8000;

function toTc(symbol) {
  const c = String(symbol || "").trim();
  if (!/^\d{6}$/.test(c)) return null;
  if (c.startsWith("6")) return "sh" + c;
  if (c.startsWith("0") || c.startsWith("3")) return "sz" + c;
  if (c.startsWith("8") || c.startsWith("4")) return "bj" + c;
  return null;
}

// 腾讯 qt 行情字段（~ 分割）：1=名称 3=现价 21=涨跌幅% 34=总市值(亿)
// 批量返回为 v_xxx="..." 连续排列（分号/换行分隔不定），用 matchAll 逐条提取（避免并发共享全局正则的 lastIndex 状态污染）。
function parseOne(tc, body) {
  const f = body.split("~");
  const num = (i) => {
    const v = f[i];
    return v === undefined || v === "" ? null : Number(v);
  };
  return { tc, name: f[1] || null, price: num(3), changePct: num(32), mktCapYi: num(45) };
}

async function fetchBatch(tcList) {
  const url = `https://qt.gtimg.cn/q=${tcList.join(",")}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT),
    cache: "no-store",
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const txt = new TextDecoder("gbk").decode(new Uint8Array(await res.arrayBuffer()));
  const out = new Map();
  for (const m of txt.matchAll(/v_([a-z0-9]+)="([^"]*)"/g)) {
    out.set(m[1], parseOne(m[1], m[2]));
  }
  return out;
}

function chunk(arr, n) {
  const r = [];
  for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n));
  return r;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function main() {
  if (!fs.existsSync(MAP_PATH)) {
    console.error("缺 industry-map.json:", MAP_PATH);
    process.exit(1);
  }
  const map = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
  const ind2codes = {};
  for (const [code, ind] of Object.entries(map)) {
    if (!ind) continue;
    (ind2codes[ind] ||= []).push(code);
  }
  const allCodes = Object.keys(map).filter((c) => toTc(c)).map(toTc);
  console.log(`行业数 ${Object.keys(ind2codes).length}，个股 ${allCodes.length}`);

  const quotes = new Map();
  let fail = 0;
  const groups = chunk(chunk(allCodes, BATCH), CONC);
  for (let wi = 0; wi < groups.length; wi++) {
    const wave = groups[wi];
    const rs = await Promise.allSettled(
      wave.map((g) => (g.length ? fetchBatch(g) : Promise.resolve(new Map()))),
    );
    for (const r of rs) {
      if (r.status !== "fulfilled") {
        fail++;
        continue;
      }
      for (const [k, v] of r.value) quotes.set(k, v);
    }
    if ((wi + 1) % 4 === 0) console.log(`  波次 ${wi + 1}/${groups.length} 已取 ${quotes.size}`);
  }

  const industries = {};
  let totalMembers = 0;
  for (const [ind, codes] of Object.entries(ind2codes)) {
    const members = [];
    for (const code of codes) {
      const tc = toTc(code);
      const q = tc ? quotes.get(tc) : null;
      if (!q || q.mktCapYi == null) continue; // 无市值剔除，页面显缺
      members.push({ code, name: q.name ?? null, mktCapYi: q.mktCapYi, changePct: q.changePct });
    }
    members.sort((a, b) => (b.mktCapYi ?? 0) - (a.mktCapYi ?? 0)); // 市值降序，龙头在前
    const med = median(members.map((m) => m.mktCapYi ?? 0));
    members.forEach((m, i) => {
      const c = m.mktCapYi ?? 0;
      // 静态市值分层（高位题材为动态，引擎实时算）：前3大或≥中位3倍=龙头，≥中位=核心，其余=二线
      m.tier = i < 3 || c >= med * 3 ? "leader" : c >= med ? "core" : "second";
    });
    industries[ind] = { count: members.length, members };
    totalMembers += members.length;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: "industry-map.json + qt.gtimg.cn(总市值字段34)",
    note: "行业=申万一级；市值降序；无市值个股已剔除；概念/二级行业为后续增强",
    industryCount: Object.keys(industries).length,
    memberCount: totalMembers,
    fetchFailWaves: fail,
    industries,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log(`完成：行业 ${out.industryCount}，有市值成分 ${totalMembers}，失败波次 ${fail}`);
  console.log("落档:", OUT_PATH);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
