import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mergeTurnover, turnoverDeltaVsPrev, cumReturnSeries, inRange, trendNotes, type IndexDayBar,
} from "../../src/lib/quant/screener/market-trend-core.ts";

// P15-R2a 大盘趋势纯核（两市成交额配对/涨跌归一）行为测 + 页面/端点接线钉。
// 核心红线：缺一边的日子合计必须是 null（不拿单边冒充两市、不补 0），
// vs 昨日只在配对齐时给——稳智那行「↓43亿 vs昨日」我们照画，但凑不出来时明说凑不出。

const readSrc = (p: string) => readFileSync(new URL(p, new URL("../../", import.meta.url)), "utf8");
const bar = (date: string, close: number, amountYi: number): IndexDayBar => ({ date, close, amountYi });

test("R2a-① mergeTurnover：按日配对取并集排序，缺一边的合计是 null 不是单边数", () => {
  const sh = [bar("2026-09-18", 1, 9000), bar("2026-09-21", 2, 9400), bar("2026-09-22", 3, 6800)];
  const sz = [bar("2026-09-18", 1, 11000), bar("2026-09-21", 2, 12000)]; // 今天深市没回来
  const pts = mergeTurnover(sh, sz);
  assert.deepEqual(pts.map((p) => p.date), ["2026-09-18", "2026-09-21", "2026-09-22"], "日期并集升序");
  assert.equal(pts[0].totalYi, 20000);
  assert.equal(pts[2].totalYi, null, "只有沪的一天不得冒充两市合计");
  assert.equal(pts[2].shYi, 6800, "单边读数照留（画沪市线用），合计位是 null");
});

test("R2a-② vs昨日：只在「最近配对日 + 上一配对日」齐时给增量；断档/全缺都是 null", () => {
  const ok = mergeTurnover(
    [bar("2026-09-17", 1, 8600), bar("2026-09-18", 1, 9900), bar("2026-09-21", 1, 9400), bar("2026-09-22", 1, 10100)],
    [bar("2026-09-17", 1, 12000), bar("2026-09-18", 1, 13000), bar("2026-09-21", 1, 12500), bar("2026-09-22", 1, 12457)],
  );
  const d = turnoverDeltaVsPrev(ok);
  assert.equal(d.deltaYi, (10100 + 12457) - (9400 + 12500), "增量按合计对合计（今天 vs 上一配对日）");
  assert.equal(d.prevDate, "2026-09-21");
  // 今天缺 → 拿最近一个有数的一天 vs 它的上一配对日（窗口尾部如实缩短，不报错）
  const tail = mergeTurnover([bar("09-21", 1, 100), bar("09-22", 1, 100)], [bar("09-21", 1, 100)]);
  assert.equal(turnoverDeltaVsPrev(tail).deltaYi, null, "只有一个配对日，没有「上一日」，vs 昨日就是 null");
  assert.equal(turnoverDeltaVsPrev([]).deltaYi, null);
});

test("R2a-③ cumReturnSeries：按区间首日归一，首日恒 0，乱序输入先排日期", () => {
  const bars = [bar("2026-09-18", 100, 1), bar("2026-09-16", 90, 1), bar("2026-09-17", 95, 1)];
  const s = cumReturnSeries(bars);
  assert.equal(s[0].date, "2026-09-16");
  assert.equal(s[0].pct, 0, "基准日固定 0%，不藏「首日也画点」的错位");
  assert.ok(Math.abs(s[2].pct - (100 - 90) / 90 * 100) < 1e-9, "累计涨跌按首日收盘归一");
  assert.deepEqual(cumReturnSeries([]), []);
});

test("R2a-④ inRange 闭区间、空串不设边；trendNotes 把「不齐」说在明处", () => {
  const bars = [bar("2026-09-16", 1, 1), bar("2026-09-17", 1, 1), bar("2026-09-18", 1, 1)];
  assert.deepEqual(inRange(bars, "", "").map((b) => b.date).length, 3);
  assert.deepEqual(inRange(bars, "2026-09-17", "2026-09-18").map((b) => b.date), ["2026-09-17", "2026-09-18"], "闭区间两头都含");
  assert.ok(trendNotes(5, 4, 3).some((n) => n.includes("不拿单边冒充两市")), "沪多深少要自报");
  assert.ok(trendNotes(5, 5, 0).some((n) => n.includes("创业板指")), "创业板缺线要自报");
  assert.deepEqual(trendNotes(5, 5, 5), [], "齐了就没有多余话");
});

test("R2a-⑤ 接线钉：端点/客户端/页面三层同吃这份纯核，趋势失败不吞情绪主体", () => {
  const route = readSrc("src/app/api/market/trend/route.ts");
  assert.ok(route.includes("mergeTurnover") && route.includes("turnoverDeltaVsPrev"), "端点只算不判：口径全在纯核");
  assert.ok(route.includes("DATE_RE"), "脏日期串一律按不设边处理，不递进上游 URL");
  const api = readSrc("src/lib/desk/quant-api.ts");
  assert.ok(api.includes("/api/market/trend"), "客户端有 fetchTrend 一条口");
  const mk = readSrc("src/components/desk/pages/MarketPage.tsx");
  assert.ok(mk.includes("loadTrend(trendFrom, trendTo)"), "日期范围进请求：加载按钮按所选区间重取");
  assert.ok(mk.includes("void loadTrend(trendFrom, trendTo)"), "首屏自动带默认窗口（近 90 天），成交额监控卡不用点按钮也有数");
  // 趋势失败落自己的小告警——不打掉情绪主体，也不共用页面级 error（setError 只管情绪快照）
  assert.ok(mk.includes("setTrendError(String((e as Error).message || e))"), "趋势失败落自己的小告警——不打掉情绪主体");
  // 宽度（5日线占比）独立链路：固定 30 天、与成交额 90 天解耦，攒不够就空置不画假线
  assert.ok(mk.includes("fetchBreadth(30)"), "宽度走独立沉淀链路（30 天窗口）");
  assert.ok(mk.includes('breadthState: EChartState = breadthBusy && bMain.length < 2 ? "loading" : bMain.length >= 2 ? "ok" : "empty"'), "宽度不足 2 点就不画（loading/empty 不假线）");
});

test("R2a-⑥ 取数层：主源通达信（带成交额）/ 备源腾讯（仅 close，amountYi 留 NaN 不冒充），元→亿换算 + 60s 小缓存", () => {
  const trend = readSrc("src/lib/quant/screener/market-trend.ts");
  assert.ok(trend.includes("tdxDayBars"), "主源：eltdx 通达信网关（本地 ~30ms，指数日K 自带 amount 成交额）");
  assert.ok(trend.includes("fetchIndexDayBars"), "统一出口函数名收口（页面/端点都吃这一份）");
  assert.ok(/\/\s*1e8/.test(trend), "元 → 亿在取数层换算完，纯核只见亿（容忍 `/ 1e8` 的空格写法）");
  assert.ok(trend.includes("ifzq.gtimg.cn"), "备源：腾讯 ifzq 日K 兜底（网关挂/超时自动降级）");
  assert.ok(trend.includes("amountYi: NaN"), "腾讯对指数的量字段是成交量不是成交额——amountYi 留 NaN，不冒充真实成交额（硬算会画错 20 倍量级）");
  assert.ok(trend.includes("MEMO_MS"), "进程内小缓存：来回切页不打穿上游");
});
