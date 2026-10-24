// 对比分析：旧文件（H=1/5，全样本）vs 新文件（H=1/5/10/20，同一样本集）
// 用法：node scripts/analyze-h10-h20.mjs
import fs from "node:fs";
const OLD = JSON.parse(fs.readFileSync("data/strategy-regime.json", "utf8"));
const NEW = JSON.parse(fs.readFileSync("data/strategy-regime-h10-h20.json", "utf8"));
const REGIMES = ["强势", "震荡", "弱势"];
const H = ["h1", "h5", "h10", "h20"];
const HLABEL = { h1: "T+1(持1日)", h5: "5天", h10: "10天", h20: "1个月(20天)" };
const f = (v, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const oldById = new Map((OLD.rows || []).map((r) => [r.id, r]));

console.log(`旧文件窗口：${OLD.window.from} → ${OLD.window.to}，${OLD.window.bars} 根，rows=${OLD.counts.rows}`);
console.log(`新文件窗口：${NEW.window.from} → ${NEW.window.to}，${NEW.window.bars} 根，rows=${NEW.counts.rows}，命中 ${NEW.counts.hits}，买不进剔除 ${NEW.counts.blocked}`);
console.log(`新文件口径：${NEW.basis.exit}`);

// ---- 每档 × 每持有期 Top5（按榜单顺序，即样本外净收益）----
for (const g of REGIMES) {
  for (const h of H) {
    const items = (NEW.rank[g] && NEW.rank[g][h]) || [];
    console.log(`\n===== ${g} · ${HLABEL[h]} Top5（榜单顺序=样本外净收益）=====`);
    console.log(`id | 策略 | 全期 n | 全期胜% | 全期净% | 样本外 n | 样本外胜% | 样本外净%`);
    for (const it of items.slice(0, 5)) {
      const a = it.all, o = it.oos;
      console.log(`${it.id} | ${it.name} | ${a.n} | ${f(a.win, 1)} | ${f(a.net)} | ${o ? o.n : "—"} | ${o ? f(o.win, 1) : "—"} | ${o ? f(o.net) : "—"}`);
    }
  }
}

// ---- 每个档 × H=10/H=20 的最佳策略，对比其 H=1/H=5（同一样本集 + 旧文件）----
console.log(`\n===== 最佳策略横向对比（同一策略 × 四个持有期）=====`);
for (const g of REGIMES) {
  for (const h of ["h10", "h20"]) {
    const top = (NEW.rank[g][h] || [])[0];
    if (!top) { console.log(`${g} ${HLABEL[h]}：无上榜策略`); continue; }
    const row = NEW.rows.find((r) => r.id === top.id);
    const old = oldById.get(top.id);
    const oldReg = old ? old[g] : null;
    console.log(`\n${g} ${HLABEL[h]} 最佳：${top.id}/${top.name}（${top.basis}）`);
    for (const hh of H) {
      const all = row.byRegime[g].all[hh], oos = row.byRegime[g].oos[hh];
      console.log(`  ${HLABEL[hh]}：全期 n=${all?.n ?? "—"} 胜${f(all?.win, 1)}% 净${f(all?.net)}% ｜ 样本外 n=${oos?.n ?? "—"} 胜${f(oos?.win, 1)}% 净${f(oos?.net)}%`);
    }
    if (oldReg) {
      console.log(`  [旧文件对照 ${g}] 全期 n=${oldReg.n} 胜${f(oldReg.win, 1)}% 净1=${f(oldReg.avg)}% 净5=${f(oldReg.avg5)}% ｜ 样本外 n=${oldReg.oos?.n ?? "—"} 胜${f(oldReg.oos?.win, 1)}% 净1=${f(oldReg.oos?.net1)}% 净5=${f(oldReg.oos?.net5)}%`);
    } else console.log(`  [旧文件对照] 无该策略/该档数据`);
  }
}

// ---- 榜单整体：各档 × 各持有期 Top15 样本外净收益均值（看持有期拉长是变好还是变差）----
console.log(`\n===== 榜单整体：Top15 样本外净收益均值 / 胜率均值（按持有期）=====`);
for (const g of REGIMES) {
  for (const h of H) {
    const items = (NEW.rank[g][h] || []).filter((it) => it.oos);
    if (!items.length) { console.log(`${g} ${HLABEL[h]}：无样本外成绩`); continue; }
    const mNet = items.reduce((s, it) => s + it.oos.net, 0) / items.length;
    const mWin = items.reduce((s, it) => s + it.oos.win, 0) / items.length;
    const pos = items.filter((it) => it.oos.net > 0).length;
    console.log(`${g} ${HLABEL[h]}：Top${items.length} 样本外净收益均值 ${f(mNet)}% ｜ 胜率均值 ${f(mWin, 1)}% ｜ 净收益>0 的策略 ${pos}/${items.length}`);
  }
}

// ---- 全期口径：所有策略在各持有期的中位净收益（分档）----
console.log(`\n===== 全期口径：全部可回测策略分档净收益中位数（n≥100 才计）=====`);
for (const g of REGIMES) {
  for (const h of H) {
    const vals = NEW.rows.map((r) => r.byRegime[g].all[h]).filter((s) => s && s.n >= 100).map((s) => s.net);
    const wins = NEW.rows.map((r) => r.byRegime[g].all[h]).filter((s) => s && s.n >= 100).map((s) => s.win);
    vals.sort((a, b) => a - b); wins.sort((a, b) => a - b);
    const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
    const pos = vals.filter((v) => v > 0).length;
    console.log(`${g} ${HLABEL[h]}：策略数 ${vals.length}，净收益中位数 ${f(med(vals))}% ｜ 胜率中位数 ${f(med(wins), 1)}% ｜ 净收益>0 的策略 ${pos}/${vals.length}`);
  }
}
