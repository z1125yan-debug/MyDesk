// scripts/quant/build-sector-snapshot.mjs
// Phase 0②「每日板块快照留档」（盘中/收盘后均可跑，腾讯实时快照）：
//   读 data/sector-constituents.json（申万行业 -> 成分股 + 静态龙头/核心/二线档），
//   抓 qt.gtimg.cn 实时涨跌幅，按行业聚合：
//     breadth（上涨家数/占比）、均值/中位涨跌幅、结构性分解（龙头/核心/二线组涨跌）、
//     龙头组下带比例、RS 代理（行业中位 - 全A中位）、领涨/领跌样本。
//   落档 data/sector-daily-snapshots.json：按交易日 upsert；与上一交易日算 Δ（驱动扫描器「风险变化」）。
//   避东财断源；不猜，缺实时价的成分股在统计分母里剔除（页面如实显示覆盖不足）。
//
// 历史库（stock_daily_close 04-20~09-24）由 backfill-sector-history.py 回补到同一文件，两路口径一致。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const CONSTITUENTS_PATH = path.join(ROOT, "data", "sector-constituents.json");
const ARCHIVE_PATH = path.join(ROOT, "data", "sector-daily-snapshots.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BATCH = 60;
const CONC = 6;
const TIMEOUT = 8000;

// 北京时间交易日 YYYY-MM-DD（与调度器同源：UTC+8 无夏令时）
function beijingDate(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}
function beijingStamp(d = new Date()) {
  const b = new Date(d.getTime() + 8 * 3600_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())} ${p(b.getUTCHours())}:${p(b.getUTCMinutes())}`;
}

function toTc(symbol) {
  const c = String(symbol || "").trim();
  if (!/^\d{6}$/.test(c)) return null;
  if (c.startsWith("6")) return "sh" + c;
  if (c.startsWith("0") || c.startsWith("3")) return "sz" + c;
  if (c.startsWith("8") || c.startsWith("4")) return "bj" + c;
  return null;
}

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
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

async function main() {
  if (!fs.existsSync(CONSTITUENTS_PATH)) {
    console.error("缺 sector-constituents.json:", CONSTITUENTS_PATH);
    process.exit(1);
  }
  const cons = JSON.parse(fs.readFileSync(CONSTITUENTS_PATH, "utf8"));
  const industriesSrc = cons.industries || {};
  const codeToName = {};
  for (const obj of Object.values(industriesSrc)) {
    for (const m of obj.members || []) codeToName[m.code] = m.name || m.code;
  }
  const indNames = Object.keys(industriesSrc);
  console.log(`申万行业 ${indNames.length} 个，开始抓腾讯实时快照…`);

  // code(6位) -> tc；industry -> [{code, tier}]
  const indMembers = {};
  const codeToTc = new Map();
  const tcToCode = new Map();
  for (const [ind, obj] of Object.entries(industriesSrc)) {
    const ms = (obj.members || []).map((m) => ({ code: m.code, tier: m.tier }));
    indMembers[ind] = ms;
    for (const m of ms) {
      const tc = toTc(m.code);
      if (tc) {
        codeToTc.set(m.code, tc);
        tcToCode.set(tc, m.code);
      }
    }
  }
  const allTc = [...new Set([...codeToTc.values()])];
  console.log(`成分股 ${allTc.length} 只`);

  const quotes = new Map();
  let fail = 0;
  const groups = chunk(chunk(allTc, BATCH), CONC);
  for (let wi = 0; wi < groups.length; wi++) {
    const wave = groups[wi];
    const rs = await Promise.allSettled(wave.map((g) => (g.length ? fetchBatch(g) : Promise.resolve(new Map()))));
    for (const r of rs) {
      if (r.status !== "fulfilled") {
        fail++;
        continue;
      }
      for (const [k, v] of r.value) quotes.set(k, v);
    }
    if ((wi + 1) % 4 === 0) console.log(`  波次 ${wi + 1}/${groups.length} 已取 ${quotes.size}`);
  }

  // 全A 涨跌幅池（RS 基准）
  const allAChanges = [];
  for (const tc of allTc) {
    const q = quotes.get(tc);
    if (q && typeof q.changePct === "number" && isFinite(q.changePct)) allAChanges.push(q.changePct);
  }
  const allAMedian = median(allAChanges);
  const allAAdv = allAChanges.filter((x) => x > 0).length;
  const allADec = allAChanges.filter((x) => x < 0).length;

  const industries = [];
  let totalCov = 0;
  for (const ind of indNames) {
    const ms = indMembers[ind];
    const ch = [];
    const named = []; // {name, c} 带名字，供 top 展示
    const byTier = { leader: [], core: [], second: [] };
    let adv = 0,
      dec = 0,
      unch = 0,
      cov = 0;
    for (const m of ms) {
      const q = quotes.get(codeToTc.get(m.code));
      if (!q || typeof q.changePct !== "number" || !isFinite(q.changePct)) continue; // 缺实时价剔除
      cov++;
      const c = q.changePct;
      ch.push(c);
      named.push({ name: codeToName[m.code] || m.code, c });
      if (c > 0) adv++;
      else if (c < 0) dec++;
      else unch++;
      if (byTier[m.tier]) byTier[m.tier].push(c);
    }
    if (!cov) continue; // 整行业无数据不写
    totalCov += cov;
    const sorted = [...named].sort((a, b) => b.c - a.c);
    const top = sorted
      .slice(0, 3)
      .concat(sorted.slice(-3))
      .map((x) => ({ name: x.name, changePct: r2(x.c) }));
    const med = median(ch);
    const leaderDec = byTier.leader.filter((x) => x < 0).length;
    industries.push({
      name: ind,
      count: cov,
      adv,
      dec,
      unch,
      advPct: r2((adv / cov) * 100),
      meanChange: r2(mean(ch)),
      medianChange: r2(med),
      leaderChange: r2(mean(byTier.leader)),
      coreChange: r2(mean(byTier.core)),
      secondChange: r2(mean(byTier.second)),
      leadersDecliningPct: byTier.leader.length ? r2((leaderDec / byTier.leader.length) * 100) : null,
      rsProxy: allAMedian == null ? null : r2(med - allAMedian),
      top: top.map((t) => ({ name: t.name, changePct: r2(t.changePct) })),
    });
  }
  industries.sort((a, b) => (a.medianChange ?? 0) - (b.medianChange ?? 0)); // 跌最多的在前

  const tradeDate = beijingDate();
  const day = {
    tradeDate,
    computedAt: beijingStamp(),
    kind: "sw-industry",
    source: "qt.gtimg.cn 实时快照(changePct 字段32)",
    session: "intraday",
    allA: {
      count: allAChanges.length,
      adv: allAAdv,
      dec: allADec,
      medianChange: r2(allAMedian),
    },
    industries,
  };

  // 落档 + Δ
  let archive = { meta: null, days: {} };
  if (fs.existsSync(ARCHIVE_PATH)) {
    try {
      archive = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8"));
    } catch {
      console.error("归档解析失败，重建:", ARCHIVE_PATH);
    }
  }
  archive.meta = {
    universe: "申万一级行业(industry-map.json)",
    note: "每日 upsert；盘中多次抓会刷新同日期；Δ 由上一交易日推算；历史库由 backfill-sector-history.py 从 stock_daily_close 回补",
    source: "qt.gtimg.cn(实时) / stock_daily_close(历史)",
    caveat: "历史库用当前成分回放=幸存者/快照偏差（universeMembership=current_only），非 04-20 实际成分",
  };
  const prevDates = Object.keys(archive.days)
    .filter((d) => d < tradeDate)
    .sort();
  const prevDate = prevDates.length ? prevDates[prevDates.length - 1] : null;
  if (prevDate) {
    const prev = archive.days[prevDate];
    const prevMap = new Map((prev.industries || []).map((x) => [x.name, x]));
    for (const ind of day.industries) {
      const p = prevMap.get(ind.name);
      if (!p) continue;
      ind.delta = {
        prevDate,
        medianChange: r2(ind.medianChange - (p.medianChange ?? 0)),
        advPct: r2((ind.advPct ?? 0) - (p.advPct ?? 0)),
        rsProxy: ind.rsProxy == null || p.rsProxy == null ? null : r2(ind.rsProxy - p.rsProxy),
      };
    }
    day.deltaBase = { prevDate };
  }
  archive.days[tradeDate] = day;

  // 自算「前期涨幅」序列：用每个行业逐日 medianChange 链式还原价位，
  // 算 prevChange5/20/60/120 + 距20日高点回撤 + 距MA60距离，写回每一天（含今日）。
  // 让快照自包含——引擎直接读，今天也有前期涨幅，不再依赖 python 回补字段。
  const series = {}; // 行业名 -> [{date, mc}]
  for (const [d, dd] of Object.entries(archive.days)) {
    for (const ind of dd.industries || []) {
      (series[ind.name] ||= []).push({ date: d, mc: ind.medianChange });
    }
  }
  for (const arr of Object.values(series)) arr.sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const [name, arr] of Object.entries(series)) {
    const L = []; // 链式价位指数
    for (let i = 0; i < arr.length; i++) {
      const mc = arr[i].mc;
      const valid = mc != null && isFinite(mc);
      L.push(valid ? (i ? L[i - 1] : 1) * (1 + mc / 100) : (i ? L[i - 1] : 1));
      const prev = (w) => (i < w || !valid ? null : r2((L[i] / L[i - w] - 1) * 100));
      const dh = () => {
        if (i < 19 || !valid) return null;
        let mx = -Infinity;
        for (let k = i - 19; k <= i; k++) mx = Math.max(mx, L[k]);
        return r2((L[i] / mx - 1) * 100);
      };
      const ma = () => {
        if (i < 59 || !valid) return null;
        let s = 0;
        for (let k = i - 59; k <= i; k++) s += L[k];
        return r2((L[i] / (s / 60) - 1) * 100);
      };
      const tgt = (archive.days[arr[i].date].industries || []).find((x) => x.name === name);
      if (tgt) {
        tgt.prevChange5 = prev(5);
        tgt.prevChange20 = prev(20);
        tgt.prevChange60 = prev(60);
        tgt.prevChange120 = prev(120);
        tgt.distFromHigh20 = dh();
        tgt.distMA60 = ma();
      }
    }
  }

  fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(archive, null, 2), "utf8");

  console.log(`\n[${day.computedAt}] 盘中快照完成：覆盖 ${totalCov} 只 / ${industries.length} 行业；失败波次 ${fail}`);
  console.log(`全A：涨 ${allAAdv} / 跌 ${allADec} / 中位 ${r2(allAMedian)}%`);
  console.log(`上一交易日基准：${prevDate || "（无，首日留档）"}`);
  console.log("跌幅最大行业 TOP8：");
  for (const ind of industries.slice(0, 8)) {
    const d = ind.delta ? `  Δ中位 ${ind.delta.medianChange}` : "";
    console.log(
      `  ${ind.name.padEnd(8)} 中位 ${String(ind.medianChange).padStart(7)}%  宽度 ${String(ind.advPct).padStart(6)}%  龙头 ${String(ind.leaderChange).padStart(7)}%  龙头下带 ${ind.leadersDecliningPct == null ? "—" : ind.leadersDecliningPct + "%"}${d}`,
    );
  }
  console.log("落档:", ARCHIVE_PATH);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
