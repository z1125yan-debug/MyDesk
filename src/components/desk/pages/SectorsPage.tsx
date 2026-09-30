"use client";
// 板块排行（P1-2 起家，P12-① 升级为「行业/概念」双 Tab）：板块榜 + 点击展开成分股 + 跳个股画像
// + P12-②「去选股」出口：板块是选股的入口不是看板终点（对齐稳智 Sectors 页核心设计）。
// REAL_DATA_ONLY：现有封装取不到的列显式「暂无数据」，不做演示兜底。
import { useState, useEffect, useCallback, useRef } from "react";
import { LayoutGrid, Loader2, RefreshCw, X, Filter } from "lucide-react";
import { PctText, NumText } from "../SourceBadge";
import { LineageCard, LineageSection, StatCard } from "../ui/LineageCard";
import { useDesk } from "@/lib/desk/store";
import EChart from "@/components/desk/charts/EChart";
import { aggregateSectors } from "@/lib/quant/screener/sector-stats-core";
// P15-R20b：外盘与 A50 的背离判定挂在 /api/market/sentiment 的 divergence 字段上，
// 板块页原来没有外盘视角，这里只取那一块（判定句与四条证据都由服务端纯核写好，页面原样显示）。
// 类型只从 overseas-core 拿（纯核、零 IO），quant-api 里那个字段就是它的可空引用。
import { fetchSentiment } from "@/lib/desk/quant-api";
import type { Divergence } from "@/lib/quant/data/overseas-core";
// P15-R16c：开盘自动重取 + 取数时刻的人话读法（全站共用，别再各页抄一份倒计时）
import { useLivePoll } from "@/hooks/use-live-poll";
import { clockZh } from "@/lib/desk/plain-core";
import { plainCode, codeTitle } from "@/lib/desk/code-format";

type BoardKind = "industry" | "concept";

interface SectorRow {
  code: string;
  secid: string;
  name: string;
  changePct: number;
  main: number;
  ratio: number;
  superBig: number;
  big: number;
  leader: string;
  rps: number;
  /** 腾讯板块兜底榜：资金四列是占位 0，必须显示「—」而不是 0.00 */
  fundsMissing?: boolean;
  /** P15-R7 同花顺兜底榜：main 是真净额，净占比/超大单/大单无该拆分（0 是占位），这些列显「—」 */
  breakdownMissing?: boolean;
  /** 板块广度（MCP get_stock_board_industry_summary 口径）：板块内上涨/下跌家数；取不到则 null → 显「暂无」 */
  up_count?: number | null;
  down_count?: number | null;
  /** 板块内涨停家数（本地涨停池 × 本地行业映射统计）；取不到 → 显「—」 */
  limit_up_count?: number | null;
  /** 较上一交易日的排名变化（负=名次前进）；没快照 → null → 显「—」 */
  rank_change?: number | null;
}

interface MemberRow {
  symbol: string; name: string; industry: string | null;
  price: number | null; changePct: number | null;
  amountYi: number | null; turnover: number | null; mainNetYi: number | null;
  st: boolean; suspended: boolean;
}

export default function SectorsPage() {
  const go = useDesk((s) => s.go);
  const setFocusSymbol = useDesk((s) => s.setFocusSymbol);
  const takeFocusSector = useDesk((s) => s.takeFocusSector);
  const setScanBoard = useDesk((s) => s.setScanBoard);
  const setScreenerHandoff = useDesk((s) => s.setScreenerHandoff);

  /** P12-①：榜单种类——行业与概念是两张榜（fs=m:90+t:2 / t:3），切换即换数据源，文案同步 */
  const [kind, setKind] = useState<BoardKind>("industry");
  const noun = kind === "concept" ? "概念" : "板块";

  const [list, setList] = useState<SectorRow[] | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [asOf, setAsOf] = useState("");
  // 榜单真正的交易日（接口 trade_date）：休市日早上抓的是上一交易日行情，
  // 日期列若用 as_of（抓取钟）会把 9/30 的行情标成今天，与顶栏休市横幅打架
  const [tradeDate, setTradeDate] = useState("");
  const poll = useLivePoll();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /**
   * P15-R20b 顶部那一行「外盘与 A50 是不是背离」：另一条通路（/api/market/sentiment）的独立取数，
   * 与板块榜的 list/error/busy 完全隔离——这一路失败只把这一行置成「没读到」，不拖榜单。
   * `state:"loading"` 只是行内一个小转圈，不是一套骨架；`divergence:null` = 这一路没算出来（不是「无背离」）。
   */
  const [overseasLine, setOverseasLine] = useState<{ state: "loading" | "done"; divergence: Divergence | null }>({ state: "loading", divergence: null });
  const [openBoard, setOpenBoard] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [membersBusy, setMembersBusy] = useState(false);
  const [membersError, setMembersError] = useState("");
  // 资金流向分布图（稳智 /sectors 同款）：前10流入 + 后10流出 合并成一张图；bar=柱状图 / pie=饼图
  const [flowMode, setFlowMode] = useState<"bar" | "pie">("bar");
  // P47 对齐稳智 /sectors 控制面板：排序字段 / 排序方向 / 范围筛选（字段+最小值+最大值）。
  // 本地是实时快照，只有「涨跌幅 / 资金流向」两列有真值可排可筛；稳智的历史字段本地无源。
  const [sortField, setSortField] = useState<"change_pct" | "money_flow_billions">("change_pct");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [filterField, setFilterField] = useState<"change_pct" | "money_flow_billions">("change_pct");
  const [filterMin, setFilterMin] = useState<number | null>(null);
  const [filterMax, setFilterMax] = useState<number | null>(null);
  /**
   * P7-⑧② 跳转联动的结算结果：从对话正文点板块名过来时，store 里留下一个待定位的 BK 代码（focusSector）。
   * 这里只记「这一跳结算成了哪种」，用来把话说明白：展开了 / 本来就已展开 / 查无此板块 / 榜单没取到。
   * 判「查无此板块」必须等榜单到手，否则等于把「这次没取到」说成「市面上不存在」。
   */
  const [jump, setJump] = useState<{
    code: string;
    outcome: "expanded" | "already" | "absent" | "no-list";
    name?: string;
    total?: number;
    reason?: string;
  } | null>(null);

  // 结算那一跳时要知道「这个板块此刻是不是已经开着」：那一刻还处在异步回调里，闭包中的 openBoard 是旧值。
  // ref 只在 effect 里同步，不在渲染期写。
  const openBoardRef = useRef(openBoard);
  useEffect(() => { openBoardRef.current = openBoard; }, [openBoard]);

  // 展开某个板块的成分股（只负责「开」，「关」由行点击走 closeBoard：这样跳转侧不必知道现在开着谁）
  // P12-①：成分股接口按 kind 认榜（行业/概念是两套 b:BKxxxx 成分），必须带上当前 Tab 的种类。
  const openMembers = useCallback(async (code: string) => {
    setOpenBoard(code); setMembers(null); setMembersError(""); setMembersBusy(true);
    try {
      const res = await fetch(`/api/market/sectors/${encodeURIComponent(code)}?kind=${kind}`);
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "成分股获取失败");
      setMembers(j.list ?? []);
    } catch (e) {
      setMembersError(String((e as Error).message || e));
      setMembers(null);
    } finally {
      setMembersBusy(false);
    }
  }, [kind]);
  const closeBoard = useCallback(() => { setOpenBoard(null); setMembers(null); }, []);

  /**
   * 结算递过来的那一跳：取一次即清（takeFocusSector），命中就展开成分股，查不到就只留一条提示——
   * 不静默跳转，也不拿「上一个板块」的成分股顶数。
   * rows 由调用方把手上那份榜单传进来：此刻 setList 还没提交，读 state 只会读到旧的。
   */
  const settleJump = useCallback((rows: SectorRow[] | null, reason: string) => {
    const code = takeFocusSector();
    if (!code) return;
    if (!rows) { setJump({ code, outcome: "no-list", reason }); return; }
    const hit = rows.find((b) => b.code.toUpperCase() === code.toUpperCase());
    if (!hit) { setJump({ code, outcome: "absent", total: rows.length }); return; }
    const wasOpen = openBoardRef.current === hit.code;
    if (!wasOpen) void openMembers(hit.code);
    setJump({ code, outcome: wasOpen ? "already" : "expanded", name: hit.name });
  }, [openMembers, takeFocusSector]);

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/market/sectors?kind=${kind}`);
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `${noun}榜获取失败`);
      const rows = (j.list ?? []) as SectorRow[];
      setList(rows);
      setMissing(j.missing ?? []);
      setAsOf(j.as_of ?? "");
      setTradeDate(j.trade_date ?? String(j.as_of ?? "").slice(0, 10));
      // 榜单到手才结算这一跳（await 之后，不在 effect 体内同步改状态）
      settleJump(rows, "");
    } catch (e) {
      const msg = String((e as Error).message || e);
      setError(msg);
      setList(null);
      // 取不到也要交代：跳转不能无声消失，否则用户以为是页面坏了
      settleJump(null, msg);
    } finally {
      setBusy(false);
    }
  }, [settleJump, kind, noun]);

  /**
   * 顶部外盘那一行的取数（P15-R20b）。三条纪律：
   * ① setState 全在 await 之后——effect 的同步路径里不 setState，不给 lint 基线添一条；
   * ② 独立 try/catch，失败只把这一行置成「没读到」，绝不写 list/error/busy（板块榜不陪葬）；
   * ③ 重取期间保留上一条读数继续显示，不闪骨架、不清空。
   */
  const loadOverseas = useCallback(async () => {
    try {
      const s = await fetchSentiment();
      setOverseasLine({ state: "done", divergence: s.divergence ?? null });
    } catch {
      setOverseasLine({ state: "done", divergence: null });
    }
  }, []);

  // 榜单与外盘那一行跟着同一个刷新节奏走（useLivePoll 的 tick）：挂进同一个 effect 的依赖，不新起计时器
  useEffect(() => { load(); void loadOverseas(); }, [load, loadOverseas, poll.tick]);

  // 为什么只在这里结算、不给 store 加订阅：板块页是 `page === "sectors"` 才挂载的（AppShell 里条件渲染），
  // 而带可点正文的两个入口（助手页、分析页小窗）都在别的页面上——点链接必然是「先切页、后挂载」，
  // 挂载必然带上一次 load()，交接就在那里结算。哪天板块页改成常驻渲染、或本页上出现了对话面，
  // 这里才需要补一个订阅；现在写订阅就是给不存在的场景写代码。
  const openProfile = (symbol: string) => { setFocusSymbol(symbol); go("profile"); };
  /**
   * P12-②「去选股」出口：把这一棒递给 AI 选股页（store 一次性交接，页面挂载后自动跑一轮池筛选）。
   * 板块代码必须是东财 BKxxxx 才能解析成分池——腾讯兜底榜的代码不是这个口径，
   * 递过去只会在选股页炸出一句「板块代码非法」，所以这里直接不出按钮（宁缺不假）。
   */
  const canScreen = (code: string) => /^BK\d{4}$/i.test(code);
  const screenBoard = (b: SectorRow) => {
    setScanBoard({ code: b.code, name: b.name, kind });
    go("aiscan");
  };
  /**
   * P48（对齐稳智 /sectors）：点板块名 → 跳「量化条件选股」并预置一条 `sector_concept like <板块名>` 条件。
   * 稳智原实现：window.open("/screener?sector=<名>&type=<industry|concept>")，选股页把参数规整成
   * {field:"sector|concept", op:"like", value:<名>} 后立即筛。本站用 store 一次性交接同一棒。
   */
  const jumpToScreener = (b: SectorRow) => {
    setScreenerHandoff({ sectorLike: b.name, kind });
    go("aiscreener");
  };
  /** P12-①：切 Tab = 换数据源，上一张榜的展开态/跳转结算态必须一起清掉（留着就是把 A 榜成分挂到 B 榜行下） */
  const switchKind = (k: BoardKind) => {
    if (k === kind) return;
    setKind(k); closeBoard(); setJump(null); setList(null);
  };

  // 四种结算结果各说一句实话，写在页面上而不是只留在 console
  const jumpNotice = !jump ? ""
    : jump.outcome === "no-list" ? `想定位「${jump.code}」，但${noun}榜这次没取到${jump.reason ? `（${jump.reason}）` : ""}，未展开任何成分股`
    : jump.outcome === "absent" ? `「${jump.code}」不在当前${noun}榜（共 ${jump.total ?? 0} 个${noun}）里，未展开成分股`
    : jump.outcome === "already" ? `已定位到「${jump.name}」（${jump.code}）：该行本来就已展开，未重复开合`
    : `已按对话里的链接展开「${jump.name}」（${jump.code}）的成分股`;

  // P15-R3b 页面血缘卡制：原来标题行、三条告警横条、统计五卡、榜单表各自散摆，
  // 收成一张卡——标题行=控制面板（Tab+刷新在右），卡内按血缘分节：提醒 → 统计 → 排行。
  // 数据口径一个字没动：兜底榜出身行、缺列自报、跳转结算都在原位。
  /**
   * P47 对齐稳智 /sectors：先按「范围筛选」过滤，再按「排序字段/方向」排序（稳智同序）。
   * 本地是实时快照——排名按当前排序后的位次现算；稳智的历史字段（排名变化/家数）本地无源，列内如实显「暂无」。
   * 统计卡仍用完整 list（稳智的 stats 也只吃全量，不受筛选影响）。
   */
  const view = (() => {
    const src = list ?? [];
    const val = (r: SectorRow) => (filterField === "change_pct" ? r.changePct : r.main);
    const filtered = src.filter((r) => {
      if (filterField === "money_flow_billions" && r.fundsMissing) return false; // 占位 0 不参与资金筛选
      const v = val(r);
      if (filterMin !== null && v < filterMin) return false;
      if (filterMax !== null && v > filterMax) return false;
      return true;
    });
    const key = (r: SectorRow) => (sortField === "change_pct" ? r.changePct : r.main);
    return filtered.slice().sort((a, b) => (sortDir === "desc" ? key(b) - key(a) : key(a) - key(b)));
  })();
  const hasFilter = filterMin !== null || filterMax !== null;
  const applyQuick = (lo: number, hi: number) => { setFilterField("change_pct"); setFilterMin(lo); setFilterMax(hi); };
  const resetFilters = () => { setSortField("change_pct"); setSortDir("desc"); setFilterField("change_pct"); setFilterMin(null); setFilterMax(null); };
  /**
   * 「排名」= 涨幅榜名次（按 change_pct 降序的**固定位次**），不随当前排序字段/筛选变化——
   * 对齐稳智的 rank 口径（后端字段，不是当前视图行号）。按资金流向排序时名次仍显示涨幅位次。
   */
  const rankByCode = (() => {
    const m = new Map<string, number>();
    (list ?? []).slice().sort((a, b) => b.changePct - a.changePct).forEach((r, i) => m.set(r.code, i + 1));
    return m;
  })();

  const alerted = Boolean(error) || missing.length > 0 || Boolean(jumpNotice);

  return (
    <div className="w-full space-y-4 px-6 py-4">
      <LineageCard
        // 稳智 /sectors 是「板块与概念分析」一个固定标题 + 板块/概念双 Tab，标题不随 Tab 变
        title={<span className="flex items-center gap-2"><LayoutGrid size={17} className="text-sky-400" />板块与概念分析</span>}
        note={
          <>
            {!list || !list.length
              ? error ? "数据源失败，未出榜" : "榜单未取到"
              : list.every((r) => r.fundsMissing)
              ? "腾讯板块榜（涨幅口径，不含主力资金读数）"
              : list.every((r) => r.breakdownMissing && !r.fundsMissing)
              ? "同花顺板块资金流榜（净额=流入−流出，无净占比/超大单/大单拆分）"
              : "东财板块榜（主力资金口径）"}
          </>
        }
        actions={
          <div className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground">
            <span className={poll.open ? "text-emerald-400" : "text-amber-400/80"}>
              ● {poll.open ? "交易中" : `A股${poll.sessionLabel}`}
            </span>
            <span className="text-muted-foreground/50">·</span>
            <span className="tabular-nums">{asOf ? `数据截至 ${clockZh(asOf) || asOf}` : "本次未取到数据"}</span>
          </div>
        }
      >
      {/* 稳智同款副标题（免责声明） */}
      <p className="mt-1 text-[12.5px] leading-5 text-muted-foreground">
        基于公开数据的历史资金流向及涨跌统计分析。所示内容仅供市场研究与分析，不构成任何投资建议。投资有风险，决策需谨慎。
      </p>

      {/* P47 稳智同款控制面板（control-panel）：Tab + 排序字段/方向 + 范围筛选 + 快速筛选 + 刷新/重置。
          本地实时快照只有「涨跌幅 / 资金流向」两列可排可筛，故排序/筛选字段只列这两个（稳智另有排名/家数，需其历史接口）。 */}
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-overlay/40 px-3 py-2 text-[12.5px]">
        {/* 板块数据 / 概念数据 Tab */}
        <div className="flex rounded-lg border border-border p-0.5 text-xs">
          {([["industry", "板块数据"], ["concept", "概念数据"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => switchKind(k)}
              className={"rounded-md px-3 py-1.5 transition-all duration-200 " + (kind === k ? "bg-sky-500/20 font-medium text-sky-300" : "text-muted-foreground hover:text-foreground")}>
              {label}
            </button>
          ))}
        </div>
        <span className="mx-0.5 h-4 w-px bg-border" />
        {/* 排序字段 + 方向 */}
        <span className="text-muted-foreground">排序字段</span>
        <select value={sortField} onChange={(e) => setSortField(e.target.value as "change_pct" | "money_flow_billions")}
          className="rounded-md border border-border bg-card px-2 py-1 text-[12.5px] text-foreground outline-none hover:border-sky-400/40">
          <option value="change_pct">涨跌幅</option>
          <option value="money_flow_billions">资金流向</option>
        </select>
        <select value={sortDir} onChange={(e) => setSortDir(e.target.value as "desc" | "asc")}
          className="rounded-md border border-border bg-card px-2 py-1 text-[12.5px] text-foreground outline-none hover:border-sky-400/40">
          <option value="desc">降序</option>
          <option value="asc">升序</option>
        </select>
        <span className="mx-0.5 h-4 w-px bg-border" />
        {/* 范围筛选：字段 + 最小值 至 最大值 */}
        <span className="text-muted-foreground">筛选字段</span>
        <select value={filterField} onChange={(e) => setFilterField(e.target.value as "change_pct" | "money_flow_billions")}
          className="rounded-md border border-border bg-card px-2 py-1 text-[12.5px] text-foreground outline-none hover:border-sky-400/40">
          <option value="change_pct">涨跌幅</option>
          <option value="money_flow_billions">资金流向(亿)</option>
        </select>
        <span className="text-muted-foreground">范围:</span>
        <input type="number" inputMode="decimal" value={filterMin ?? ""} placeholder="最小值"
          onChange={(e) => setFilterMin(e.target.value === "" ? null : Number(e.target.value))}
          className="w-20 rounded-md border border-border bg-card px-2 py-1 text-right text-[12.5px] text-foreground outline-none hover:border-sky-400/40" />
        <span className="text-muted-foreground">至</span>
        <input type="number" inputMode="decimal" value={filterMax ?? ""} placeholder="最大值"
          onChange={(e) => setFilterMax(e.target.value === "" ? null : Number(e.target.value))}
          className="w-20 rounded-md border border-border bg-card px-2 py-1 text-right text-[12.5px] text-foreground outline-none hover:border-sky-400/40" />
        {hasFilter && (
          <span className="flex items-center gap-1 rounded-full border border-sky-400/40 bg-sky-400/10 px-2 py-0.5 text-[11.5px] text-sky-200" title="当前有生效的范围筛选">
            ✓ 筛选生效
          </span>
        )}
        {/* 快速筛选（仅涨跌幅口径，与稳智一致） */}
        <span className="ml-1 text-muted-foreground">快速筛选:</span>
        {([["下跌(0~-5%)", -5, 0], ["上涨(0~5%)", 0, 5], ["震荡(-10~10%)", -10, 10]] as const).map(([label, lo, hi]) => {
          const on = filterField === "change_pct" && filterMin === lo && filterMax === hi;
          return (
            <button key={label} onClick={() => applyQuick(lo, hi)}
              className={`rounded-full border px-2.5 py-1 text-[12px] transition-all active:scale-95 ${on ? "border-sky-400/60 bg-sky-400/15 text-sky-200" : "border-border/60 bg-card text-muted-foreground hover:border-sky-400/40"}`}>
              {label}
            </button>
          );
        })}
        <span className="mx-0.5 h-4 w-px bg-border" />
        <button onClick={load} disabled={busy}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新数据
        </button>
        <button onClick={resetFilters}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-sky-500/40 hover:text-sky-300">
          重置筛选
        </button>
      </div>

      {/* P15-R20b 外盘与 A50 背离：通栏一行（这页原来没有任何外盘视角，看不出「今天 A 股跌是自己弱还是外盘带的」）。
          判定句与四条证据都是服务端纯核写好的原文，这里原样摆：四条各带自己的行情时刻或「距今 N 天」，
          美股那几条是上一段美东收盘、恒指与 A50 是实时——这个差别必须摆在明面上，页面不折算时区、不另拼一句、不给建议。 */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-border/60 bg-card px-3 py-2 text-[13px]">
        {overseasLine.state === "loading" ? (
          <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Loader2 size={12} className="animate-spin" /> 外盘与 A50 读数中…
          </span>
        ) : overseasLine.divergence ? (
          <>
            <span>{overseasLine.divergence.line}</span>
            {overseasLine.divergence.evidence.map((e) => (
              <span key={e} title="这条读数的行情时刻（上游原样：美股那几条是上一段美东收盘，恒指与 A50 是实时）"
                className="rounded-full border border-border/60 px-2 py-0.5 text-[11.5px] text-muted-foreground">
                {e}
              </span>
            ))}
            {overseasLine.divergence.missing.length > 0 && (
              <span className="ml-auto text-[11.5px] text-amber-300/90"
                title={overseasLine.divergence.missing.join("\n")}>
                外盘这几条有 {overseasLine.divergence.missing.length} 项没读到
              </span>
            )}
          </>
        ) : (
          <span className="text-[12.5px] text-muted-foreground">
            外盘与 A50 这次没读到，判不了是不是背离——不是没有背离
          </span>
        )}
      </div>

      {/* 异常时才出现的一行极简提示：数据源失败 / 缺列 / 从对话跳转过来的结算说明。
          默认不显示，替代掉原本整个「数据提醒」LineageSection。 */}
      {(error || missing.length > 0 || jumpNotice) && (
        <div className="flex flex-col gap-1.5">
          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-300">
              {error}
            </div>
          )}
          {missing.length > 0 && (
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-1.5 text-[12px] text-amber-300/90">
              暂无数据：{missing.join("、")}
            </div>
          )}
          {jumpNotice && (
            <div className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-1.5 text-[12px] text-sky-200">
              <span className="flex-1">{jumpNotice}</span>
              <button onClick={() => setJump(null)} aria-label="关闭跳转提示" className="text-muted-foreground hover:text-sky-300">
                <X size={12} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* P12-①统计行：5 张聚合卡（对齐稳智 stats-row）。数字只从当前榜真实读数聚合，
          缺的不补 0——主力合计遇腾讯兜底榜占位 0 时整体显「—」，口径见 sector-stats-core。 */}
      {list && list.length > 0 && (() => {
        const st = aggregateSectors(list);
        const cards: { label: string; value: string; tone: string; title: string }[] = [
          { label: `总${noun}数`, value: String(st.count), tone: "text-sky-300", title: "当前榜内去重后的条数（资金口径榜，非全市场板块总数）" },
          { label: "平均涨跌幅", value: st.avgChangePct === null ? "—" : `${st.avgChangePct > 0 ? "+" : ""}${st.avgChangePct}%`, tone: (st.avgChangePct ?? 0) >= 0 ? "text-red-400" : "text-emerald-400", title: "榜内涨跌幅平均" },
          // 个股口径优先：MCP 板块汇总取到广度（up_count/down_count）就按家数求和，与稳智同名卡同口径；
          // 取不到才回落板块条数，且卡片名必须改成「板块数」——不拿板块条数冒充个股家数。
          st.upStocks != null
            ? { label: "总上涨家数", value: st.upStocks.toLocaleString("zh-CN"), tone: "text-red-400", title: `板块内上涨个股求和（${st.breadthBoards}/${st.count} 个板块有广度读数，缺的不按 0 计入）` }
            : { label: "总上涨板块数", value: String(st.upBoards), tone: "text-red-400", title: `MCP 板块汇总未取到个股广度，回落为涨幅为正${kind === "concept" ? "的概念" : "的行业板块"}条数（板块口径，不是个股家数）` },
          st.downStocks != null
            ? { label: "总下跌家数", value: st.downStocks.toLocaleString("zh-CN"), tone: "text-emerald-400", title: "板块内下跌个股求和（同上口径）" }
            : { label: "总下跌板块数", value: String(st.downBoards), tone: "text-emerald-400", title: "MCP 板块汇总未取到个股广度，回落为跌幅为负的板块条数" },
          { label: "总资金流向", value: st.mainSumYi === null ? "—" : `${st.mainSumYi > 0 ? "+" : ""}${st.mainSumYi}亿`, tone: (st.mainSumYi ?? 0) >= 0 ? "text-red-400" : "text-emerald-400", title: st.mainSumYi === null ? st.mainMissingNote : "榜内主力净额求和（亿）· 稳智同名卡为「总资金流向」" },
          ...(st.limitUpStocks != null
            ? [{ label: "总涨停家数", value: String(st.limitUpStocks), tone: "text-red-400", title: "板块内涨停个股求和（本地涨停池 × 行业映射；映射未覆盖的票不计入任何板块）" }]
            : []),
        ];
        return (
          <LineageSection title="统计" hint={`${noun}榜口径，缺读数显「—」不补 0`} divided={alerted}>
            <div className="apple-stagger grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {cards.map((c, i) => (
                <StatCard key={i} label={c.label} value={c.value} toneClass={c.tone} title={c.title} />
              ))}
            </div>
          </LineageSection>
        );
      })()}

      {/* 资金流向分布（稳智 /sectors 同款）：按资金流向排序，前10流入 + 后10流出 合并成一张图；柱图 ⇄ 饼图。
          数据源只用榜内已有的主力净额（main），fundsMissing 的行资金是占位 0，一律剔除不出图。 */}
      {(() => {
        const usable = (list ?? []).filter((r) => !r.fundsMissing && r.main !== 0);
        const byFlow = usable.slice().sort((a, b) => b.main - a.main);
        const rows = [...byFlow.slice(0, 10), ...byFlow.slice(-10).reverse()];
        /**
         * 2026-09-29 用户改版：「改成竖着的」——横条图看着别扭。
         * 竖柱口径：**左→右按资金流向从大到小**（红的流入在左、绿的流出在右），
         * 正数向上（零线之上）、负数向下（零线之下），板块名沿 x 轴斜排。
         */
        const desc = rows.slice().sort((a, b) => b.main - a.main);
        const barOption = {
          grid: { left: 52, right: 18, top: 26, bottom: 74 },
          tooltip: {
            trigger: "axis", axisPointer: { type: "shadow" },
            formatter: (ps: { name: string; value: number }[]) =>
              `${ps[0]?.name ?? ""}<br/>资金流向：<b>${Number(ps[0]?.value ?? 0).toFixed(2)}</b> 亿`,
          },
          xAxis: {
            type: "category", data: desc.map((r) => r.name),
            // 20 个板块名必须全显（interval:0），斜排 45° 免得挤成一团
            axisLabel: { color: "#8b949e", fontSize: 10, rotate: 45, interval: 0, hideOverlap: false },
            axisLine: { lineStyle: { color: "#30363d" } },
            axisTick: { alignWithLabel: true },
          },
          yAxis: {
            type: "value", name: "亿",
            axisLabel: { color: "#8b949e", fontSize: 10 },
            splitLine: { lineStyle: { type: "dashed", color: "#30363d" } },
          },
          series: [{
            type: "bar", barMaxWidth: 26,
            // A股习惯：流入红、流出绿（红柱在零线之上、绿柱在零线之下）
            data: desc.map((r) => ({ value: r.main, itemStyle: { color: r.main >= 0 ? "#f85149" : "#3fb950" } })),
            // 零线画出来，读者一眼分得清「净流入/净流出」的分界
            markLine: {
              silent: true, symbol: "none", animation: false,
              lineStyle: { color: "#6e7681", width: 1 },
              label: { show: false },
              data: [{ yAxis: 0 }],
            },
          }],
        };
        const pieOption = {
          tooltip: { trigger: "item", formatter: "{b}<br/>资金流向：{c} 亿（{d}%）" },
          legend: { type: "scroll", bottom: 0, textStyle: { color: "#8b949e", fontSize: 10 } },
          series: [{
            type: "pie", radius: ["34%", "62%"], center: ["50%", "44%"],
            data: rows.map((r) => ({ name: r.name, value: +Math.abs(r.main).toFixed(2), itemStyle: { color: r.main >= 0 ? "#f85149" : "#3fb950" } })),
            label: { color: "#8b949e", fontSize: 10 },
          }],
        };
        return (
          <LineageSection
            title="资金流向分布"
            hint="前10流入 + 后10流出（稳智同款合并图）· 竖柱：左→右由流入到流出，红柱向上（净流入）/绿柱向下（净流出）· 资金为占位 0 的板块不进图"
            divided={alerted}
            actions={
              <div className="flex gap-1.5">
                {([["bar", "柱状图"], ["pie", "饼图"]] as const).map(([m, label]) => (
                  <button key={m} onClick={() => setFlowMode(m)}
                    className={`rounded-full border px-2.5 py-1 text-[12.5px] transition-all active:scale-95 ${flowMode === m ? "border-sky-400/60 bg-sky-400/15 text-sky-200" : "border-border/60 bg-card text-muted-foreground hover:border-sky-400/40"}`}>
                    {label}
                  </button>
                ))}
              </div>
            }
          >
            <EChart
              ariaLabel="资金流向分布"
              height={420}
              state={!list ? "loading" : rows.length ? "ok" : "empty"}
              emptyText="榜内没有可用的主力净额读数（资金列是占位 0，不画假图）"
              option={flowMode === "bar" ? barOption : pieOption}
            />
          </LineageSection>
        );
      })()}

      {list && (
        <LineageSection
          title={`${noun}数据`}
          hint={hasFilter ? `筛选结果: ${view.length} / ${list.length} 条数据` : `共 ${view.length} 条数据`}
          divided={alerted || (list?.length ?? 0) > 0}
        >
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table key={kind} className="w-full text-[14px] apple-fade-in">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  {["ID", "名称", "日期", "涨跌幅%", "排名", "排名变化", "上涨家数", "下跌家数", "涨停家数", "资金流向(亿)"].map((h) => (
                    <th key={h} className="px-3.5 py-2.5 text-center whitespace-nowrap font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.length === 0 && (
                  <tr><td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">
                    {list.length === 0 ? "暂无数据" : "当前筛选条件下没有匹配的板块，请调整范围或点「重置筛选」"}
                  </td></tr>
                )}
                {view.map((b) => (
                  <SectorBlock key={b.code} rank={rankByCode.get(b.code) ?? 0} board={b} asOf={asOf} tradeDate={tradeDate}
                    expanded={openBoard === b.code}
                    busy={membersBusy} error={membersError} members={members}
                    canScreen={canScreen(b.code)}
                    onToggle={() => (openBoard === b.code ? closeBoard() : void openMembers(b.code))}
                    onOpenProfile={openProfile} onScreen={() => screenBoard(b)} onJumpScreener={() => jumpToScreener(b)} />
                ))}
              </tbody>
            </table>
          </div>
        </LineageSection>
      )}
      {!list && !busy && !error && (
        <div className="py-8 text-center text-sm text-muted-foreground">暂无{noun}数据</div>
      )}
      </LineageCard>
    </div>
  );
}

function SectorBlock({ rank, board, asOf, tradeDate, expanded, busy, error, members, canScreen, onToggle, onOpenProfile, onScreen, onJumpScreener }: {
  rank: number; board: SectorRow; asOf: string; tradeDate: string; expanded: boolean;
  busy: boolean; error: string; members: MemberRow[] | null;
  canScreen: boolean;
  onToggle: () => void; onOpenProfile: (s: string) => void; onScreen: () => void; onJumpScreener: () => void;
}) {
  // 排名变化的口径要跟着值一起说清：没有上一交易日快照时不能让「—」看起来像「排名没变」
  const rankChangeTitle = board.rank_change == null
    ? "较上一交易日的排名变化：暂无上一交易日板块快照（本页每访问一次留一份当日排名，第 2 个交易日起自动有数）"
    : board.rank_change === 0
      ? "较上一交易日：名次不变"
      : `较上一交易日：名次${board.rank_change > 0 ? "前进" : "后退"} ${Math.abs(board.rank_change)} 位`;
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer border-b border-border/40 hover:bg-sky-500/5">
        <td className="px-3.5 py-2.5 text-center font-mono text-[13px] text-muted-foreground whitespace-nowrap">{board.code}</td>
        {/* 名称=可点搜索入口（对齐稳智 /sectors：点板块名开 /screener?sector=…）：
            点击跳「量化条件选股」并预置 `sector_concept like <板块名>` 条件；stopPropagation 避免顺手展开成分股。 */}
        <td className="px-3.5 py-2.5 text-center font-medium whitespace-nowrap">
          <button onClick={(e) => { e.stopPropagation(); onJumpScreener(); }}
            title={`点「${board.name}」→ 去量化条件选股并预置「板块/概念 包含 ${board.name}」条件（对齐稳智）`}
            className="text-left text-sky-300 underline-offset-2 hover:text-sky-200 hover:underline">
            {board.name}
          </button>
        </td>
        {/* 日期=行情所属交易日（接口 trade_date），不是抓取钟点；抓取时间在页头「数据截至」里说 */}
        <td className="px-3.5 py-2.5 text-center text-[13px] text-muted-foreground whitespace-nowrap" title={`行情交易日 ${tradeDate || "未知"} · 数据抓取于 ${asOf || "未知"}`}>{tradeDate || (asOf ? asOf.slice(0, 10) : "—")}</td>
        <td className="px-3.5 py-2.5 text-center"><PctText value={board.changePct} /></td>
        <td className="px-3.5 py-2.5 text-center font-mono text-muted-foreground">{rank}</td>
        {/* 较上一交易日的排名变化：今日名次 − 上一交易日名次（负=前进）。没有上一交易日快照就显「—」，不编 0 */}
        <td className="px-3.5 py-2.5 text-center" title={rankChangeTitle}>
          {board.rank_change == null
            ? <span className="text-[13px] text-muted-foreground">—</span>
            : board.rank_change === 0
              ? <span className="text-[13px] text-muted-foreground">0</span>
              : board.rank_change > 0
                ? <span className="font-medium text-red-400">▲{board.rank_change}</span>
                : <span className="font-medium text-emerald-400">▼{Math.abs(board.rank_change)}</span>}
        </td>
        <td className="px-3.5 py-2.5 text-center" title="板块内上涨家数（MCP get_stock_board_industry_summary 口径）">{board.up_count == null ? <span className="text-[13px] text-muted-foreground">暂无</span> : <span className="text-red-400">{board.up_count}</span>}</td>
        <td className="px-3.5 py-2.5 text-center" title="板块内下跌家数（MCP get_stock_board_industry_summary 口径）">{board.down_count == null ? <span className="text-[13px] text-muted-foreground">暂无</span> : <span className="text-emerald-400">{board.down_count}</span>}</td>
        <td className="px-3.5 py-2.5 text-center" title="板块内涨停家数：本地涨停池 × 本地行业映射（data/industry-map.json）统计">
          {board.limit_up_count == null
            ? <span className="text-[13px] text-muted-foreground">—</span>
            : <span className={board.limit_up_count > 0 ? "font-medium text-red-400" : "text-[13px] text-muted-foreground"}>{board.limit_up_count}</span>}
        </td>
        <td className="px-3.5 py-2.5 text-center whitespace-nowrap">{board.fundsMissing ? <span className="text-muted-foreground">—</span> : <PctText value={board.main} suffix="" />}</td>
      </tr>
      {/* 展开面板常驻渲染 + max-height/opacity 过渡：点击行即滑入/收起（open 与 close 都有动画），
          不再用 {expanded && ...}（卸载无收起动画）。只有当前 openBoard 行 expanded=true，其余行收成 0 高。 */}
      <tr className="border-b border-border/40 bg-background/50">
        <td colSpan={10} className="p-0">
          <div className={"overflow-hidden transition-[max-height,opacity] duration-300 ease-out " + (expanded ? "max-h-[26rem] opacity-100" : "max-h-0 opacity-0")}>
            <div className="px-4 py-3">
            {/* 「去 AI 选股」（原独立列，精简列后收进展开面板）：板块是选股的入口不是看板终点 */}
            <div className="mb-2 flex items-center gap-2">
              {canScreen ? (
                <button onClick={(e) => { e.stopPropagation(); onScreen(); }} title={`以「${board.name}」成分为股票池去 AI 选股`}
                  className="flex items-center gap-1 rounded-md border border-sky-500/40 px-2.5 py-1 text-[13px] text-sky-300 hover:bg-sky-500/10">
                  <Filter size={12} /> 以该板块成分去 AI 选股
                </button>
              ) : (
                <span title="该榜行代码非东财 BK 口径（腾讯/同花顺兜底榜），无法解析成分池" className="text-[12px] text-muted-foreground">该板块代码非东财 BK 口径，无法解析成分池</span>
              )}
              <span className="text-[12px] text-muted-foreground">点击上方「名称」可跳量化条件选股并预置板块条件</span>
            </div>
            {busy && <div className="flex items-center gap-2 py-4 text-xs text-sky-400"><Loader2 size={12} className="animate-spin" /> 拉取成分股…</div>}
            {!busy && error && <div className="py-4 text-xs text-red-300">{error}</div>}
            {!busy && !error && members && (
              <div className="max-h-80 overflow-y-auto desk-scroll">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      {["代码", "名称", "现价", "涨跌幅", "成交额(亿)", "换手%", "主力净额(亿)", "行业"].map((h) => (
                        <th key={h} className="px-2.5 py-1.5">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...members]
                      .sort((a, b) => (b.changePct ?? -999) - (a.changePct ?? -999))
                      .map((m) => (
                        <tr key={m.symbol} onClick={() => onOpenProfile(m.symbol)} className="cursor-pointer border-b border-border/30 hover:bg-sky-500/5">
                          <td className="px-2.5 py-1.5 font-mono" title={codeTitle(m.symbol)}>{plainCode(m.symbol)}</td>
                          <td className="px-2.5 py-1.5">{m.name}{m.st && <span className="ml-1 text-[10px] text-amber-400">ST</span>}{m.suspended && <span className="ml-1 text-[10px] text-muted-foreground">停牌</span>}</td>
                          <td className="px-2.5 py-1.5 text-right"><NumText value={m.price} /></td>
                          <td className="px-2.5 py-1.5 text-right"><PctText value={m.changePct} /></td>
                          <td className="px-2.5 py-1.5 text-right"><NumText value={m.amountYi} digits={1} /></td>
                          <td className="px-2.5 py-1.5 text-right"><NumText value={m.turnover} /></td>
                          <td className="px-2.5 py-1.5 text-right"><PctText value={m.mainNetYi} suffix="" /></td>
                          <td className="px-2.5 py-1.5 text-[12px] text-muted-foreground">{m.industry ?? "—"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
            </div>
            </div>
          </td>
        </tr>
    </>
  );
}
