// P6-C「AI Market Research」的事实组装服务层：把「当前市场环境」的真实读数从已有引擎/已有库里取出来，
// 编号成服务端台账（research-core 的 EvidenceLine），再组装成给模型的提示词。
//
// 这一层的立场（任务书 §十一/§十二/§三十二）：
// - **不重算**：MA/MACD/RSI/IC/回测/条件概率一律由已有 Quant Engine 产出，这里只是把它们读出来；
//   所以每个采集器调的都是页面同源的那一个函数（computeSentiment / discoverThemes / fetchBoardReal / 库表），
//   本文件里没有任何一个指标公式。
// - **优先已有结果**：能读库就不打上游（radar/events/factor_test/三张留档表都是读库），
//   上游取数全部走 em.ts 里已有的短时缓存；同一次组装里同一个读数只调一次
//   （computeSentiment 一次产出全市场广度、涨跌停梯队、指数、风险等级四组读数）。
// - **失败优先**：某个采集器抛错 ⇒ 记进 missing 并保留原因，不沿用上一次结果、不用 0 或估算顶上；
//   库里 0 行按「真实为空」说明（NO_SIGNALS / 没留档），不写成「一切正常」。
//
// 口径：这一层产出的只有 FACTS / SIGNALS / HISTORICAL_EVIDENCE 三层（服务端所有）。
// AI 的四层（解释/风险/未知/下一步）必须经过 research-core 的复校验才进库，见 storeResearchReport。
import { db } from "@/lib/db";
import { fetchBoardReal } from "@/lib/desk/em";
import { shanghaiDate, shanghaiStamp } from "@/lib/desk/session";
import { verifiedLedgerMeta } from "@/lib/quant/factors/fields.ts";
import { computeSentiment } from "./sentiment";
import { discoverThemes } from "./themes";
import { loadEventFacts } from "./event-interpret";
import { parseJsonColumn } from "./history-core.ts";
import {
  MAX_LEDGER_LINES, RESEARCH_PROMPT_VERSION, RESEARCH_SCOPE_NOT_IMPLEMENTED, RESEARCH_SYSTEM_PROMPT,
  assignEvidenceIds, buildResearchPrompt, capLedger, parseResearchOutput, researchDateError, researchReportKey, researchScopeOf,
  type CollectorStatus, type EvidenceLine, type ResearchReport, type ResearchScope, type SourceProbe,
} from "./research-core.ts";

type NewLine = Omit<EvidenceLine, "id">;

// 采集器观测的类型定义在内核里（客户端与服务端同一份），这里原样转出去，避免两处字段清单漂移。
export type { CollectorStatus, SourceProbe } from "./research-core.ts";

interface Collected {
  lines?: NewLine[];
  missing?: string[];
  /** 省略时按「有没有出台账行」自动判 ok / empty */
  status?: CollectorStatus;
  as_of?: string;
  note?: string;
}

const n1 = (v: unknown): string => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? String(Math.round(x * 10) / 10) : "null";
};
const signed = (v: unknown): string => {
  const x = Number(v);
  if (!Number.isFinite(x)) return "null";
  return `${x > 0 ? "+" : ""}${Math.round(x * 10) / 10}`;
};
/** 台账行文本定长上限：一行说不完的就截断，超长会把提示词撑爆；截断事实留在行尾标注里 */
const clip = (s: string, max = 220): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…（已截断）` : t;
};

function line(
  layer: EvidenceLine["layer"],
  capability: string,
  text: string,
  source: string,
  as_of: string,
  data_status: EvidenceLine["data_status"],
): NewLine {
  return { layer, capability, text: clip(text), source, as_of: as_of || "未记录", data_status };
}

/** 采集器统一包装：抛错 ⇒ failed + 原样原因；空结果 ⇒ empty + 调用方给的空说明（两种都不进台账，但都进 missing） */
async function collect(
  cap: { capability: string; title: string; source: string; data_status: EvidenceLine["data_status"] },
  run: () => Promise<Collected>,
): Promise<{ probe: SourceProbe; lines: NewLine[]; missing: string[] }> {
  const emptyProbe = (status: CollectorStatus, as_of: string, note: string, count: number): SourceProbe => ({
    capability: cap.capability, title: cap.title, status, as_of: as_of || "未记录", source: cap.source,
    data_status: cap.data_status, lines: count, note,
  });
  try {
    const r = await run();
    const lines = r.lines ?? [];
    const missing = (r.missing ?? []).map((m) => `${cap.title}（${cap.capability}）：${m}`);
    const status = r.status ?? (lines.length ? "ok" : "empty");
    return { probe: emptyProbe(status, r.as_of ?? "", r.note ?? "", lines.length), lines, missing };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 200);
    return {
      probe: emptyProbe("failed", "", `本次取数失败：${msg}`, 0),
      lines: [],
      missing: [`${cap.title}（${cap.capability}）本次取数失败：${msg} —— 按缺失处理：不沿用上一次结果，也不用 0 或估算值顶上`],
    };
  }
}

export interface ResearchFacts {
  scope: ResearchScope;
  /** 服务端北京时间交易日：台账里的实时读数都是这一天的口径 */
  date: string;
  as_of: string;
  lines: EvidenceLine[];
  /** 本次采集的逐能力观测（页面顶部与 Tool Calls 侧栏显示的就是它，不是模型的工具调用） */
  sources: SourceProbe[];
  missing: string[];
  /** 超出 MAX_LEDGER_LINES 被截断的行数（0 = 没截断） */
  truncated: number;
  basis: string;
}

/**
 * 组装台账。每个采集器只做一件事，失败互不影响（一个源挂了不会把整份报告变成空）。
 * 三层归属：全市场广度/板块榜/事件快讯 = FACTS；风险等级/主线判定/雷达信号 = SIGNALS；
 * 条件概率留档/因子 IC/留档覆盖/无可靠来源能力 = HISTORICAL_EVIDENCE。
 */
export async function collectResearchFacts(): Promise<ResearchFacts> {
  const date = shanghaiDate();
  const as_of = shanghaiStamp();
  const buckets = await Promise.all([
    // ---- 一次 computeSentiment 同时供四组读数：全市场广度、涨跌停梯队、指数、风险等级（§三十二 不重复调底层） ----
    collect(
      { capability: "market_snapshot", title: "全市场广度与风险等级", source: "全 A 快照 + 指数实时（sentiment 引擎）", data_status: "REAL" },
      async () => {
        const s = await computeSentiment();
        const stamp = s.as_of || as_of;
        const lines: NewLine[] = [
          line("FACTS", "market_snapshot",
            `全 A ${s.total} 只：上涨 ${s.advancers}、下跌 ${s.decliners}、平盘 ${s.flat}；中位涨跌幅 ${n1(s.median_pct)}%；成交额合计 ${n1(s.amount_total_yi)}亿；主力净额合计 ${signed(s.main_net_sum_yi)}亿；${s.live ? "盘中实时" : "收盘/休市值（非盘中实时）"}`,
            s.source?.provider ? `全 A 快照（${s.source.provider}）` : "全 A 快照（东财 clist）", stamp, "REAL"),
          line("FACTS", "limitup",
            `涨停 ${s.limit_up} 家、跌停 ${s.limit_down} 家；触板 ${s.touched_limit}、炸板 ${s.limit_up_broken}，炸板率 ${s.break_rate === null ? "算不出（当日触板数为 0，不以 0% 代替）" : `${n1(s.break_rate)}%`}`,
            "全 A 快照 + 涨跌停判定引擎", stamp, "DERIVED"),
        ];
        if (s.indices?.length) {
          lines.push(line("FACTS", "index_benchmark",
            `指数：${s.indices.map((i) => `${i.name} ${n1(i.price)}（${signed(i.changePct)}%）`).join("；")}`,
            "腾讯指数实时", stamp, "REAL"));
        }
        lines.push(line("SIGNALS", "risk",
          `市场风险等级「${s.risk.level}」；触发指标：${s.risk.triggers?.length ? s.risk.triggers.join("、") : "本次无指标越线（空不是「安全」，只是没触发这套阈值）"}`,
          "全 A 快照风险引擎", stamp, "DERIVED"));
        const missing = (s.missing ?? []).map((m) => `引擎本次自报缺失：${m}`);
        if (!s.indices?.length) missing.push("指数实时无返回：本次台账里没有指数读数");
        return { lines, missing, as_of: stamp };
      },
    ),
    // ---- 主线发现（引擎内自带 45 秒缓存，不在本层重复实现） ----
    collect(
      { capability: "themes", title: "主线发现（规则版）", source: "东财板块榜 + 成分扩散 + 板块资金（themes 引擎）", data_status: "DERIVED" },
      async () => {
        const th = await discoverThemes();
        const top = (list: typeof th.main, n: number) => (list ?? []).slice(0, n)
          .map((x) => `${x.name}(${n1(x.score)}分)`)
          .join("、");
        const lines: NewLine[] = [];
        if (th.main?.length || th.sub?.length || th.rotation?.length || th.watch?.length) {
          lines.push(line("SIGNALS", "themes",
            `主线 ${th.main.length} 个（${top(th.main, 3) || "无"}）；次主线 ${th.sub.length}；轮动 ${th.rotation.length}；观察 ${th.watch.length}；判定口径=涨幅/RPS/扩散/资金同步/连续强势`,
            "themes 引擎（板块榜+扩散+资金）", th.as_of || as_of, "DERIVED"));
        }
        const missing = (th.missing ?? []).map((m) => `引擎自报缺失：${m}`);
        if (!lines.length) missing.push("主线发现本次没有任何分组结果：库里/上游此刻确实没有可列的主线，不是「没有主线=安全」");
        return { lines, missing, as_of: th.as_of || as_of };
      },
    ),
    // ---- 板块资金榜（东财板块榜，em.ts 短时缓存；这就是能力表里的 sector_rank / 板块主力资金流） ----
    collect(
      { capability: "sector_rank", title: "板块资金/涨幅榜", source: "东财 clist 行业板块榜（流入+流出两侧合并）", data_status: "REAL" },
      async () => {
        const [inRows, outRows] = await Promise.all([
          fetchBoardReal("industry", "in", 60),
          fetchBoardReal("industry", "out", 60),
        ]);
        if (inRows === null && outRows === null) {
          return { lines: [], status: "empty", missing: ["东财板块榜本次无返回（in/out 两侧都为 null）：台账里没有板块资金读数"] };
        }
        const merged = new Map<string, { name: string; changePct: number; main: number }>();
        for (const r of [...(inRows ?? []), ...(outRows ?? [])]) {
          if (!r.code || merged.has(r.code)) continue;
          merged.set(r.code, { name: r.name, changePct: r.changePct, main: r.main });
        }
        const all = [...merged.values()];
        const byMain = [...all].sort((a, b) => b.main - a.main).slice(0, 4);
        const byPct = [...all].sort((a, b) => b.changePct - a.changePct).slice(0, 4);
        const byOut = [...all].sort((a, b) => a.main - b.main).slice(0, 3);
        const stamp = shanghaiStamp();
        const lines: NewLine[] = [
          line("FACTS", "sector_rank",
            `行业板块 ${all.length} 个参与统计（榜单口径：东财行业板块，非证监会分类）。主力净流入前 4：${byMain.map((b) => `${b.name} ${signed(b.main)}亿/${signed(b.changePct)}%`).join("；")}`,
            "东财板块榜（本机直连）", stamp, "REAL"),
          line("FACTS", "sector_rank",
            `涨幅前 4：${byPct.map((b) => `${b.name} ${signed(b.changePct)}%（主力 ${signed(b.main)}亿）`).join("；")}`,
            "东财板块榜（本机直连）", stamp, "REAL"),
        ];
        if (byOut.length && byOut[0].main < 0) {
          lines.push(line("FACTS", "sector_rank",
            `主力净流出前 3：${byOut.map((b) => `${b.name} ${signed(b.main)}亿/${signed(b.changePct)}%`).join("；")}`,
            "东财板块榜（本机直连）", stamp, "REAL"));
        }
        const missing: string[] = [];
        if (inRows === null || outRows === null) missing.push("板块榜只取到一侧（in/out 有一侧为 null）：榜单为部分数据，已按 DEGRADED 口径提示");
        missing.push("个股主力资金流（fund_flow_stock）与北向净流入未进本批台账：前者需要明确代码，后者无可靠来源 ⇒ 见 HISTORICAL_EVIDENCE 的 MISSING 行");
        return { lines, missing, as_of: stamp };
      },
    ),
    // ---- 雷达：读库（不触发扫描，扫描是写操作） ----
    collect(
      { capability: "radar", title: "AI 主动发现（当日库行）", source: "SQLite radar_finding（只读）", data_status: "REAL" },
      async () => {
        const rows = await db.radarFinding.findMany({ where: { asOf: date, state: "live" }, orderBy: { createdAt: "desc" } });
        const byKind = new Map<string, number>();
        for (const r of rows) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
        const superseded = await db.radarFinding.count({ where: { asOf: date, state: "superseded" } });
        if (!rows.length) {
          return {
            lines: [], status: "empty",
            missing: [`当日 radar_finding 的 live 行为 0（真实为空，不是失败）：可能当天没扫描、或扫描了但规则没命中；要新结果必须显式触发扫描（写操作，本层不做）`],
            note: `0 行 live（superseded ${superseded} 行）`,
          };
        }
        const lines: NewLine[] = [
          line("SIGNALS", "radar",
            `当日雷达 live 信号 ${rows.length} 条（按类型：${[...byKind.entries()].map(([k, v]) => `${k} ${v}`).join("、")}）；已被后续扫描判为不再产出的 superseded ${superseded} 条。样例：${rows.slice(0, 3).map((r) => r.title).join(" / ")}`,
            "radar_finding 表（上次扫描落库）", date, "REAL"),
        ];
        return { lines, missing: [], as_of: date, note: `${rows.length} 行 live` };
      },
    ),
    // ---- 事件：读库（复用 P6-B 的事实层：同一套库行解析与 broken_columns 口径） ----
    collect(
      { capability: "events", title: "全球事件雷达（当日库行）", source: "SQLite global_event（只读，经 P6-B 事实层解析）", data_status: "REAL" },
      async () => {
        const bundle = await loadEventFacts({ date });
        const hitSectors = new Map<string, number>();
        for (const f of bundle.facts) for (const s of f.mapped_sectors) hitSectors.set(s, (hitSectors.get(s) ?? 0) + 1);
        if (!bundle.facts.length) {
          return {
            lines: [], status: "empty",
            missing: [`${date} 的 global_event 没有任何事件行（真实为空）：消息面这一路本次没有可读的内容，不猜新闻`],
            note: "0 行",
          };
        }
        const lines: NewLine[] = [
          line("FACTS", "events",
            `当日入库事件 ${bundle.facts.length} 条；产业链映射命中板块 ${hitSectors.size} 个（${[...hitSectors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}×${v}`).join("、") || "本批事件都没命中映射表，映射为空是入库时的事实"}）。样例标题：${bundle.facts.slice(0, 3).map((f) => f.title).join(" / ")}`,
            "global_event 表（快讯来自东财/新浪）", date, "REAL"),
        ];
        const missing = bundle.issues.filter((i) => i.broken.length)
          .map((i) => `${i.key}：字段无法解析 ${i.broken.join("、")}（按缺失处理，不当作空值喂给模型）`);
        return { lines, missing, as_of: date, note: `${bundle.facts.length} 行` };
      },
    ),
    // ---- 条件概率：读留档（没有条件就没有概率，绝不自己现算一组条件） ----
    collect(
      { capability: "probability", title: "历史条件概率（留档回看）", source: "SQLite probability_snapshot（只读，§十一 概率只由 probability 引擎产出）", data_status: "HISTORICAL" },
      async () => {
        const rows = await db.probabilitySnapshot.findMany({ orderBy: { computedAt: "desc" }, take: 2 });
        if (!rows.length) {
          return {
            lines: [], status: "empty",
            missing: ["库里还没有条件概率留档：概率必须连着当时的筛选条件一起留档才有意义，研究层不会自己编一组条件去现算一个胜率"],
            note: "0 行留档",
          };
        }
        const lines: NewLine[] = rows.map((r) => {
          const pooled = parseJsonColumn<{ h: number; win_rate: number | null; sample_size: number }[]>(r.pooled, []).value;
          const conds = parseJsonColumn<unknown[]>(r.conditions, []).value;
          const hs = pooled.length
            ? pooled.map((p) => `${p.h}日胜率 ${n1(p.win_rate)}%（样本 ${p.sample_size}${p.sample_size < 30 ? "，不足 30：仅供参考" : ""}）`).join("；")
            : "pooled 列为空（留档当时就没算出任何期限的汇总）";
          return line("HISTORICAL_EVIDENCE", "probability",
            `留档（基准日 ${r.tradeDate}${r.tradeDateIsHistorical ? "，历史回放" : ""}）条件 ${Array.isArray(conds) ? conds.length : 0} 条：${hs}。${r.sampleOk ? "存在样本数 ≥30 的期限" : "所有期限样本都不足 30：只能写「仅供参考」，不得当结论"}。这是 historical/statistical，不等于今天上涨的概率`,
            "probability_snapshot 表（probability 引擎产出后留档）", r.computedAt, "HISTORICAL");
        });
        return { lines, missing: [], as_of: rows[0].computedAt, note: `${rows.length} 条留档` };
      },
    ),
    // ---- 因子验证：读 IC 跑批记录 + verified 账本元信息（只读，绝不写） ----
    collect(
      { capability: "factor_test", title: "因子 IC 测试记录", source: "SQLite factor_test（只读跑批记录）", data_status: "HISTORICAL" },
      async () => {
        const [rows, verified, total] = await Promise.all([
          db.factorTest.findMany({ orderBy: { createdAt: "desc" }, take: 4 }),
          Promise.resolve(verifiedLedgerMeta()),
          db.factorTest.count(),
        ]);
        const lines: NewLine[] = [];
        if (rows.length) {
          lines.push(line("HISTORICAL_EVIDENCE", "factor_test",
            `因子 IC 跑批共 ${total} 次记录，最近 ${rows.length} 次：${rows.map((t) => `${t.factorKey}（区间 ${t.dataRange || "未记录"}，样本 ${t.sampleStocks} 只/${t.sampleDates} 日，RankIC ${n1(t.rankIc)}，ICIR ${n1(t.icIr)}，${t.passed ? "通过" : "未通过"}）`).join("；")}`,
            "factor_test 表（因子测试台跑批）", rows[0].createdAt.toISOString().slice(0, 10), "HISTORICAL"));
        }
        lines.push(line("HISTORICAL_EVIDENCE", "factor_verified",
          verified.exists
            ? `verified 账本（${verified.path}）现有 ${verified.keys} 个信号键：只有正式批量 IC 流程能改这个状态，研究层与 AI 都不能把未验证说成已验证`
            : "verified 账本文件不存在：所有因子按 UNVERIFIED 处理（本层不会替它判已验证）",
          verified.path, "未记录", verified.exists ? "REAL" : "MISSING"));
        const missing: string[] = [];
        if (!rows.length) missing.push(`库里没有任何 factor_test 跑批记录（factor_test 表 0 行）：没有可引用的 IC/历史有效性证据`);
        missing.push("回测（backtest）未进本批台账：它需要明确的策略与区间，属于按需计算，研究层不自行发起（也不得由 AI 触发）");
        return { lines, missing, note: `最近 ${rows.length} 次跑批 + 账本元信息` };
      },
    ),
    // ---- 每日留档与历史覆盖（说明「哪天有档可回看」，这是系统的真实状态，不是市场数据） ----
    collect(
      { capability: "snapshot_risk", title: "风险/主线每日留档覆盖", source: "SQLite risk_snapshot + theme_snapshot（只读）", data_status: "SNAPSHOT" },
      async () => {
        const [riskRows, themeRows, riskDates, themeDates] = await Promise.all([
          db.riskSnapshot.findMany({ orderBy: { computedAt: "desc" }, take: 1 }),
          db.themeSnapshot.findMany({ orderBy: { computedAt: "desc" }, take: 1 }),
          db.riskSnapshot.findMany({ select: { tradeDate: true } }),
          db.themeSnapshot.findMany({ select: { tradeDate: true } }),
        ]);
        const days = (rows: { tradeDate: string }[]) => new Set(rows.map((r) => r.tradeDate)).size;
        const lines: NewLine[] = [
          line("HISTORICAL_EVIDENCE", "snapshot_risk",
            riskRows.length
              ? `风险留档覆盖 ${days(riskDates)} 个交易日，最近一条：${riskRows[0].tradeDate} 等级「${riskRows[0].level}」（${riskRows[0].computedAt}，当时 live=${riskRows[0].live}）。留档是那一刻的快照，不是实时`
              : "风险留档 0 行：留档只在人工点「留档今天」时产生，没点的那天就没有行",
            "risk_snapshot 表", riskRows[0]?.tradeDate ?? "未记录", "SNAPSHOT"),
          line("HISTORICAL_EVIDENCE", "snapshot_themes",
            themeRows.length
              ? `主线留档覆盖 ${days(themeDates)} 个交易日，最近一条：${themeRows[0].tradeDate} 主线 ${themeRows[0].mainCount} 个/次主线 ${themeRows[0].subCount} 个`
              : "主线留档 0 行（同上：留档不是自动的）",
            "theme_snapshot 表", themeRows[0]?.tradeDate ?? "未记录", "SNAPSHOT"),
        ];
        return { lines, missing: [], note: `风险 ${days(riskDates)} 天 / 主线 ${days(themeDates)} 天` };
      },
    ),
    // ---- 明确无可靠来源：照样进台账，标 MISSING，让模型只能把它写进 UNKNOWN 而不是绕过它 ----
    collect(
      { capability: "northbound_flow", title: "北向资金与板块连续强势（登记为无可靠来源）", source: "capability-core（登记表 availability=not_covered）", data_status: "MISSING" },
      async () => ({
        lines: [
          line("HISTORICAL_EVIDENCE", "northbound_flow",
            "北向资金净流入：无可靠来源（交易所自 2024-08-19 起停止披露）。本批没有这个读数，涉及资金面时不得用任何形式的北向数字（含 0 与估算）",
            "capability-core 登记表", "未记录", "MISSING"),
          line("HISTORICAL_EVIDENCE", "board_day_streak",
            "板块日K连续强势天数：东财板块日K 实测有批次无返回 ⇒ 无返回时保持缺失，不用替代口径硬凑",
            "capability-core 登记表", "未记录", "MISSING"),
          line("HISTORICAL_EVIDENCE", "stock_announcements",
            "个股公告源未接入：涉及消息面的判断只能标为假设，不得声称看过公告",
            "capability-core 登记表", "未记录", "MISSING"),
        ],
        status: "not_covered",
        note: "登记为 not_covered：以 MISSING 行的形式进台账，供 UNKNOWN 层引用",
      }),
    ),
  ]);

  const sources = buckets.map((b) => b.probe);
  const rawMissing = buckets.flatMap((b) => b.missing);
  const flat = buckets.flatMap((b) => b.lines);
  const capped = capLedger(flat, MAX_LEDGER_LINES);
  const missing = [...rawMissing];
  if (capped.dropped) {
    missing.push(`台账行数超过上限 ${MAX_LEDGER_LINES}：本次只带前 ${capped.kept.length} 行进提示词，${capped.dropped} 行未参与（不是它们不重要，是一次提问装不下）`);
  }
  const failed = sources.filter((s) => s.status === "failed").map((s) => s.capability);
  if (failed.length) missing.push(`本次失败的采集器：${failed.join("、")}（失败原因见上一条说明；报告只会基于剩下的读数，缺的那部分必须出现在 UNKNOWN 里）`);

  return {
    scope: "market",
    date,
    as_of,
    lines: assignEvidenceIds(capped.kept),
    missing,
    sources,
    truncated: capped.dropped,
    basis:
      `台账由服务端现取组装（${as_of}）：一次 computeSentiment 供广度/梯队/指数/风险四组读数，` +
      `另调 themes 引擎、东财板块榜，其余读库（radar_finding / global_event / probability_snapshot / factor_test / 三张留档表）。` +
      `本层不含任何指标公式：MA/MACD/RSI/IC/回测/条件概率一律由已有引擎产出（§十一）。` +
      `共 ${capped.kept.length} 行台账、${sources.length} 个采集器、${missing.length} 条缺失口径。`,
  };
}

export interface ResearchPromptBundle extends ResearchFacts {
  ok: boolean;
  system: string;
  prompt: string;
  prompt_version: string;
  question: string;
  error: string | null;
}

/**
 * 组装提示词（只读，不写库）。question 是人在页面上输入的研究问题，会原样进提示词。
 * 台账为空 ⇒ 不给提示词（ok=false）：没有真实读数就没有可解释的东西，也不会让模型凭问题本身编一份报告。
 */
export async function buildResearchPromptBundle(opts: { question?: string; scope?: string | null } = {}): Promise<ResearchPromptBundle> {
  const scope = researchScopeOf(opts.scope);
  const facts = await collectResearchFacts();
  const question = String(opts.question ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const missing = [...facts.missing];
  if (!scope) missing.push(RESEARCH_SCOPE_NOT_IMPLEMENTED);
  if (!question) missing.push("没有输入研究问题：本次按默认问题「当前市场环境如何」组装提示词，页面会把这一条写清楚");
  if (!facts.lines.length) missing.push("本批台账为空：服务端没有可交给模型解释的真实读数，本次不产出提示词（研究层不会凭空生成一份市场环境报告）");
  const effQuestion = question || "当前市场环境如何？（默认问题：未输入研究问题）";
  return {
    ...facts,
    missing,
    scope: scope ?? "market",
    question: effQuestion,
    ok: !!scope && facts.lines.length > 0,
    system: RESEARCH_SYSTEM_PROMPT,
    prompt: scope && facts.lines.length ? buildResearchPrompt({ question: effQuestion, as_of: facts.as_of, lines: facts.lines, missing }) : "",
    prompt_version: RESEARCH_PROMPT_VERSION,
    error: null,
  };
}

export interface ResearchStoreResult {
  ok: boolean;
  persisted: boolean;
  scope: ResearchScope;
  date: string;
  report_key: string;
  report: ResearchReport | null;
  evidence_total: number;
  missing: string[];
  sources: SourceProbe[];
  error: string | null;
  basis: string;
}

/**
 * 模型原文 → 服务端重新取一次台账 → 复校验 → 落库（同 scope+date 覆盖为最新一条）。
 * 关键：台账不接受客户端传来的事实字段。前端即使把 FACTS 行改了、塞进不存在的引用 id，
 * 这里也是用服务端现取的台账来判，报告只存引用 id 与回填的原文。
 */
export async function storeResearchReport(input: {
  raw: string; question?: string; scope?: string | null; model?: string;
}): Promise<ResearchStoreResult> {
  const scope = researchScopeOf(input.scope);
  if (!scope) {
    return {
      ok: false, persisted: false, scope: "market", date: shanghaiDate(), report_key: "",
      report: null, evidence_total: 0, missing: [RESEARCH_SCOPE_NOT_IMPLEMENTED], sources: [],
      error: RESEARCH_SCOPE_NOT_IMPLEMENTED, basis: "参数校验未通过：未写库",
    };
  }
  const facts = await collectResearchFacts();
  const stamp = shanghaiStamp();
  const question = String(input.question ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const parsed = parseResearchOutput(String(input.raw ?? ""), facts.lines, {
    question,
    as_of: facts.as_of,
    model: (input.model ?? "").trim() || "未记录",
    generated_at: stamp,
  });
  const reportKey = researchReportKey(scope, facts.date);
  if (!parsed.report) {
    return {
      ok: false, persisted: false, scope, date: facts.date, report_key: reportKey, report: null,
      evidence_total: facts.lines.length, missing: [...facts.missing, parsed.error], sources: facts.sources,
      error: parsed.error, basis: "复校验后没有产出报告对象：未写库（不会写一行空壳冒充研究结果）",
    };
  }
  // 一次失败的模型回复不应该把当天已经站得住的报告抹掉：
  // 新结论是 REJECTED 而库里那条不是 ⇒ 保留旧的，把这次失败原样报给页面（不静默覆盖，也不假装落库成功）。
  if (parsed.report.interpretation_status === "REJECTED") {
    const prev = await db.researchReport.findUnique({ where: { reportKey }, select: { status: true } });
    if (prev && prev.status !== "REJECTED") {
      return {
        ok: false, persisted: false, scope, date: facts.date, report_key: reportKey, report: parsed.report,
        evidence_total: facts.lines.length, missing: [...facts.missing, `本次模型输出被判 REJECTED，而库里已有一条 ${prev.status} 的报告：保留已有那条，失败这次没有覆盖它`],
        sources: facts.sources,
        error: `本次没有可采纳的解释（REJECTED），未覆盖库里已存在的 ${prev.status} 报告`,
        basis: "写库被拒：一次失败的回复不覆盖当天已成立的结论（页面会同时显示两边的状态）",
      };
    }
  }
  const data = {
    scope,
    asOf: facts.date,
    question,
    status: parsed.report.interpretation_status,
    model: parsed.report.model,
    promptVersion: parsed.report.prompt_version,
    headline: parsed.report.headline,
    marketPosture: parsed.report.market_posture,
    evidenceTotal: parsed.report.evidence_total,
    evidenceJson: JSON.stringify(facts.lines),
    sourcesJson: JSON.stringify(facts.sources),
    missingJson: JSON.stringify(facts.missing),
    violations: JSON.stringify(parsed.report.violations),
    payload: JSON.stringify(parsed.report),
    generatedAt: stamp,
  };
  await db.researchReport.upsert({
    where: { reportKey },
    update: data,
    create: { reportKey, ...data },
  });
  return {
    ok: parsed.ok, persisted: true, scope, date: facts.date, report_key: reportKey, report: parsed.report,
    evidence_total: facts.lines.length, missing: facts.missing, sources: facts.sources,
    error: parsed.ok ? null : parsed.error,
    basis:
      `服务端按本次现取的 ${facts.lines.length} 行台账复校验后落库 1 条（自然键 ${reportKey}：同一天同范围只留最新一条，` +
      `所以这张表最多每天一行，不会无限增长）。解释层永远标 AI_INTERPRETATION，台账三层仍是服务端所有。`,
  };
}

export interface ResearchLoadResult {
  /** 参数非法时返回同一组字段 + ok:false（§三十一：错误结构与成功结构一致），所以这里不能是字面量 true。 */
  ok: boolean;
  as_of: string;
  today: string;
  scope: ResearchScope;
  report: (ResearchReport & { report_key: string; stale_evidence: boolean }) | null;
  evidence: EvidenceLine[];
  sources: SourceProbe[];
  missing: string[];
  available_dates: { date: string; status: string; question: string }[];
  counts: { rows: number; interpreted: number; partial: number; rejected: number };
  layering: string;
  self_check: { broken_payload: string[] };
  basis: string;
  probed_at: string;
  /** 成功读取也带这个键（null=没有错误）：接口在 200/400/502 三种返回里保持同一组字段，前端不用分支猜形状。 */
  error: string | null;
}

/** 只读回看：按 scope+date 取已落库的报告，并说明台账是否已被当天后续扫描刷新。 */
export async function loadResearchReport(opts: { date?: string; scope?: string | null } = {}): Promise<ResearchLoadResult> {
  const today = shanghaiDate();
  const scope = researchScopeOf(opts.scope) ?? "market";
  const date = (opts.date ?? "").trim() || today;
  // 非法日期在这里也要挡（路由已经返 400，这里是给服务端内部调用者的同一口径）：
  // 让它走到 findFirst 只会得到「查不到」，那会被读成「那天没有报告」。
  const dateErr = researchDateError(date);
  if (dateErr) {
    return {
      ok: false, as_of: "", today, scope,
      report: null, evidence: [], sources: [], missing: [dateErr], available_dates: [],
      counts: { rows: 0, interpreted: 0, partial: 0, rejected: 0 },
      layering: "本次没有读库：日期口径不合法（错误结构与成功时一致，页面按 missing 原文显示原因）",
      self_check: { broken_payload: [] }, basis: "未读库：日期口径校验未通过", probed_at: shanghaiStamp(), error: dateErr,
    };
  }
  const rows = await db.researchReport.findMany({ orderBy: { asOf: "desc" }, take: 60 });
  const cur = await db.researchReport.findFirst({ where: { reportKey: researchReportKey(scope, date) } });
  const broken_payload: string[] = [];
  let report: ResearchReport | null = null;
  let evidence: EvidenceLine[] = [];
  let sources: SourceProbe[] = [];
  let missing: string[] = [];
  let stale = false;
  if (cur) {
    const parsedPayload = parseJsonColumn<ResearchReport | null>(cur.payload, null);
    if (!parsedPayload.value || !Array.isArray(parsedPayload.value.interpretation)) {
      broken_payload.push(`${cur.reportKey}：payload 不是可解析的报告结构（按缺失处理，不猜内容）`);
    } else {
      report = parsedPayload.value;
      evidence = parseJsonColumn<EvidenceLine[]>(cur.evidenceJson, []).value;
      sources = parseJsonColumn<SourceProbe[]>(cur.sourcesJson, []).value;
      missing = parseJsonColumn<string[]>(cur.missingJson, []).value;
      // 台账是生成那一刻冻结的快照：如果之后当天又有新的扫描落库，就要如实提示「读数已刷新，这份报告对应的是更早的一版数据」。
      // 两侧都用 shanghaiStamp 转成同一口径（库里的 createdAt 是 UTC Date，报告里存的是北京时间串），不做时区混比。
      const [lastRadar] = await db.radarFinding.findMany({
        where: { asOf: date }, orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true },
      });
      const lastScanAt = lastRadar ? shanghaiStamp(lastRadar.createdAt) : "";
      stale = !!lastScanAt && !!report.generated_at && report.generated_at !== "未记录" && lastScanAt > report.generated_at;
    }
  }
  const counts = {
    rows: rows.length,
    interpreted: rows.filter((r) => r.status === "INTERPRETED").length,
    partial: rows.filter((r) => r.status === "PARTIAL").length,
    rejected: rows.filter((r) => r.status === "REJECTED").length,
  };
  const notes: string[] = [];
  if (!cur) {
    notes.push(`${date} 还没有 ${scope} 范围的 AI 市场研究报告：这一层只在有人显式点「生成研究报告」时产生，没做过就是空（不是失败，也不会自动补）`);
  }
  if (stale) notes.push("这份报告生成之后，当天的雷达/事件库里又落了新的扫描结果：报告的台账是生成那一刻的快照，需要重做才对得上最新读数");
  if (broken_payload.length) notes.push(...broken_payload);
  if (report?.interpretation_status === "REJECTED") notes.push("该日最新一条报告状态为 REJECTED：模型那次没有给出任何可核对的解释，页面不会把它显示成结论");

  return {
    ok: true,
    as_of: date,
    today,
    scope,
    report: report ? { ...report, report_key: cur!.reportKey, stale_evidence: stale } : null,
    evidence,
    sources,
    missing: [...missing, ...notes],
    available_dates: rows.map((r) => ({ date: r.asOf, status: r.status, question: r.question })),
    counts,
    layering:
      `报告共 ${counts.rows} 条（INTERPRETED ${counts.interpreted} / PARTIAL ${counts.partial} / REJECTED ${counts.rejected}）；` +
      `FACTS / SIGNALS / HISTORICAL_EVIDENCE 由服务端台账产出，INTERPRETATION / RISKS / UNKNOWN / NEXT_CHECKS 属于 AI_INTERPRETATION 层：` +
      `AI 的解释不是事实，也不会改写任何已有读数`,
    self_check: { broken_payload },
    basis: `读 research_report(reportKey=${researchReportKey(scope, date)})，台账用落库时冻结的 evidenceJson 原样回显；只读，不重新取数、不改写`,
    probed_at: shanghaiStamp(),
    error: null,
  };
}

/** 能力探测用的轻读数：这张表有多少条、最新一天是哪天（不返回内容） */
export async function researchSignal() {
  const [rows, latest] = await Promise.all([
    db.researchReport.count(),
    db.researchReport.findFirst({ orderBy: { asOf: "desc" }, select: { asOf: true, status: true } }),
  ]);
  return { rows, date: latest?.asOf ?? null, status: latest?.status ?? null };
}
