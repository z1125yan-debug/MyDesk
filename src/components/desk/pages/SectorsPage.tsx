"use client";
// 板块排行（P1-2 起家，P12-① 升级为「行业/概念」双 Tab）：板块榜 + 点击展开成分股 + 跳个股画像
// + P12-②「去选股」出口：板块是选股的入口不是看板终点（对齐稳智 Sectors 页核心设计）。
// REAL_DATA_ONLY：现有封装取不到的列显式「暂无数据」，不做演示兜底。
import { useState, useEffect, useCallback, useRef } from "react";
import { LayoutGrid, Loader2, RefreshCw, X, Filter } from "lucide-react";
import { PctText, NumText } from "../SourceBadge";
import { LineageCard, LineageSection, StatCard } from "../ui/LineageCard";
import { useDesk } from "@/lib/desk/store";
import { aggregateSectors } from "@/lib/quant/screener/sector-stats-core";
// P15-R20b：外盘与 A50 的背离判定挂在 /api/market/sentiment 的 divergence 字段上，
// 板块页原来没有外盘视角，这里只取那一块（判定句与四条证据都由服务端纯核写好，页面原样显示）。
// 类型只从 overseas-core 拿（纯核、零 IO），quant-api 里那个字段就是它的可空引用。
import { fetchSentiment } from "@/lib/desk/quant-api";
import type { Divergence } from "@/lib/quant/data/overseas-core";
// P15-R16c：开盘自动重取 + 取数时刻的人话读法（全站共用，别再各页抄一份倒计时）
import { useLivePoll } from "@/hooks/use-live-poll";
import { clockZh } from "@/lib/desk/plain-core";

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

  /** P12-①：榜单种类——行业与概念是两张榜（fs=m:90+t:2 / t:3），切换即换数据源，文案同步 */
  const [kind, setKind] = useState<BoardKind>("industry");
  const noun = kind === "concept" ? "概念" : "板块";

  const [list, setList] = useState<SectorRow[] | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [asOf, setAsOf] = useState("");
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
  const alerted = Boolean(error) || missing.length > 0 || Boolean(jumpNotice);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-4">
      <LineageCard
        title={<span className="flex items-center gap-2"><LayoutGrid size={17} className="text-sky-400" />{kind === "concept" ? "概念板块排行" : "行业板块排行"}</span>}
        note={
          <>
            {!list || !list.length
              ? error ? "数据源失败，未出榜（下面提醒有原因）" : "榜单未取到"
              : list.every((r) => r.fundsMissing)
              ? "腾讯板块兜底榜（东财板块榜断源：涨幅口径，无主力资金读数）"
              : list.every((r) => r.breakdownMissing && !r.fundsMissing)
              ? "同花顺板块资金流榜（东财断源时的独立兜底：净额=流入−流出，无净占比/超大单/大单拆分）"
              : "东财板块榜（主力资金口径合并流入/流出两侧）"}
            {" · 点板块行展开成分股 · 点个股跳画像 · "}{asOf ? `数据截至 ${clockZh(asOf) || asOf}` : "本次未取到数据"}
            {poll.open ? ` · 开盘自动刷新，剩余 ${poll.left}s` : ` · A股${poll.sessionLabel}，自动刷新已暂停`}
          </>
        }
        actions={
          <>
            {/* P12-①：行业 / 概念 双 Tab（对齐稳智 control-tabs）——换榜即换数据源，标题/空态文案同步 */}
            <div className="flex rounded-lg border border-border p-0.5 text-xs">
              {([["industry", "行业"], ["concept", "概念"]] as const).map(([k, label]) => (
                <button key={k} onClick={() => switchKind(k)}
                  className={"rounded-md px-3 py-1.5 transition-colors " + (kind === k ? "bg-sky-500/20 font-medium text-sky-300" : "text-muted-foreground hover:text-foreground")}>
                  {label}
                </button>
              ))}
            </div>
            <button onClick={load} disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
            </button>
          </>
        }
      >
      {/* P15-R20b 外盘与 A50 背离：通栏一行（这页原来没有任何外盘视角，看不出「今天 A 股跌是自己弱还是外盘带的」）。
          判定句与四条证据都是服务端纯核写好的原文，这里原样摆：四条各带自己的行情时刻或「距今 N 天」，
          美股那几条是上一段美东收盘、恒指与 A50 是实时——这个差别必须摆在明面上，页面不折算时区、不另拼一句、不给建议。 */}
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-border/60 bg-card px-3 py-2 text-[13px]">
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

      {alerted && (
        <LineageSection title="数据提醒" tone={error ? "danger" : "warning"} divided={false}>
          {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}（数据源失败时不展示任何假数据）</div>}
          {missing.length > 0 && (
            <div className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[10.5px] leading-5 text-amber-300/90">
              暂无数据列（现有数据源封装不含该字段，拒绝演示兜底）：{missing.join("；")}。RPS 为榜单内涨幅百分位，非全市场口径。
            </div>
          )}
          {/* P7-⑧②：从对话正文点板块名跳过来时把结果写明白（命中/已展开过/查无此板块/榜单没取到），不做静默跳转 */}
          {jumpNotice && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[11px] text-sky-200">
              <span className="flex-1">{jumpNotice}</span>
              <button onClick={() => setJump(null)} aria-label="关闭跳转提示" className="text-muted-foreground hover:text-sky-300">
                <X size={12} />
              </button>
            </div>
          )}
        </LineageSection>
      )}

      {/* P12-①统计行：5 张聚合卡（对齐稳智 stats-row）。数字只从当前榜真实读数聚合，
          缺的不补 0——主力合计遇腾讯兜底榜占位 0 时整体显「—」，口径见 sector-stats-core。 */}
      {list && list.length > 0 && (() => {
        const st = aggregateSectors(list);
        const cards: { label: string; value: string; tone: string; title: string }[] = [
          { label: `总${noun}数`, value: String(st.count), tone: "text-sky-300", title: "当前榜内去重后的条数（资金口径榜，非全市场板块总数）" },
          { label: "平均涨跌幅", value: st.avgChangePct === null ? "—" : `${st.avgChangePct > 0 ? "+" : ""}${st.avgChangePct}%`, tone: (st.avgChangePct ?? 0) >= 0 ? "text-red-400" : "text-emerald-400", title: "榜内涨跌幅截面均值" },
          { label: `上涨${noun}数`, value: String(st.upBoards), tone: "text-red-400", title: `涨幅为正${kind === "concept" ? "的概念" : "的行业板块"}条数（${noun}口径，非个股上涨家数——现有数据源不含板块内个股广度字段）` },
          { label: `下跌${noun}数`, value: String(st.downBoards), tone: "text-emerald-400", title: "跌幅为负的条数（同为板块口径）" },
          { label: "主力净额合计", value: st.mainSumYi === null ? "—" : `${st.mainSumYi > 0 ? "+" : ""}${st.mainSumYi}亿`, tone: (st.mainSumYi ?? 0) >= 0 ? "text-red-400" : "text-emerald-400", title: st.mainSumYi === null ? st.mainMissingNote : "榜内主力净额求和（亿）" },
        ];
        return (
          <LineageSection title="统计" hint={`${noun}榜口径，缺读数显「—」不补 0`} divided={alerted}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {cards.map((c, i) => (
                <StatCard key={i} label={c.label} value={c.value} toneClass={c.tone} title={c.title} />
              ))}
            </div>
          </LineageSection>
        );
      })()}

      {list && (
        <LineageSection title={`${noun}排行`} hint="按涨幅榜内排序 · 点行展开成分股" divided={alerted || (list?.length ?? 0) > 0}>
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  {["#", noun, "涨幅%", "主力净额(亿)", "净占比%", "超大单(亿)", "大单(亿)", "RPS(榜内)", "领涨股", "成交额", "上涨/涨停家数", "持续天数", "去选股", ""].map((h) => (
                    <th key={h} className="px-3 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.map((b, i) => (
                  <SectorBlock key={b.code} rank={i + 1} board={b}
                    expanded={openBoard === b.code}
                    busy={membersBusy} error={membersError} members={members}
                    canScreen={canScreen(b.code)}
                    onToggle={() => (openBoard === b.code ? closeBoard() : void openMembers(b.code))} onOpenProfile={openProfile}
                    onScreen={() => screenBoard(b)} />
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

function SectorBlock({ rank, board, expanded, busy, error, members, canScreen, onToggle, onOpenProfile, onScreen }: {
  rank: number; board: SectorRow; expanded: boolean;
  busy: boolean; error: string; members: MemberRow[] | null;
  canScreen: boolean;
  onToggle: () => void; onOpenProfile: (s: string) => void; onScreen: () => void;
}) {
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer border-b border-border/40 hover:bg-sky-500/5">
        <td className="px-3 py-1.5 font-mono text-muted-foreground">{rank}</td>
        <td className="px-3 py-1.5 font-medium">{board.name}<span className="ml-1 text-[10px] text-muted-foreground">{board.code}</span></td>
        <td className="px-3 py-1.5 text-right"><PctText value={board.changePct} /></td>
        <td className="px-3 py-1.5 text-right">{board.fundsMissing ? <span className="text-muted-foreground">—</span> : <PctText value={board.main} suffix="" />}</td>
        <td className="px-3 py-1.5 text-right">{board.fundsMissing || board.breakdownMissing ? <span className="text-muted-foreground">—</span> : <NumText value={board.ratio} />}</td>
        <td className="px-3 py-1.5 text-right">{board.fundsMissing || board.breakdownMissing ? <span className="text-muted-foreground">—</span> : <NumText value={board.superBig} digits={2} />}</td>
        <td className="px-3 py-1.5 text-right">{board.fundsMissing || board.breakdownMissing ? <span className="text-muted-foreground">—</span> : <NumText value={board.big} digits={2} />}</td>
        <td className="px-3 py-1.5 text-right"><NumText value={board.rps} digits={0} /></td>
        <td className="px-3 py-1.5 text-[11px]">{board.leader || "—"}</td>
        <td className="px-3 py-1.5 text-center text-[10px] text-muted-foreground">暂无数据</td>
        <td className="px-3 py-1.5 text-center text-[10px] text-muted-foreground">暂无数据</td>
        <td className="px-3 py-1.5 text-center text-[10px] text-muted-foreground">暂无数据</td>
        <td className="px-3 py-1.5 text-center">
          {/* P12-②：板块→选股的出口。stopPropagation 是底线——点按钮不该顺手把成分股展开面板开了。
              非 BK 口径代码（腾讯兜底榜）给不了成分池，按钮如实缺席而不是点了再报错。 */}
          {canScreen ? (
            <button onClick={(e) => { e.stopPropagation(); onScreen(); }} title={`以「${board.name}」成分为股票池去 AI 选股`}
              className="flex items-center gap-1 rounded-md border border-sky-500/40 px-2 py-0.5 text-[10.5px] text-sky-300 hover:bg-sky-500/10">
              <Filter size={10} /> 去选股
            </button>
          ) : (
            <span title="该榜行代码非东财 BK 口径（腾讯/同花顺兜底榜），无法解析成分池" className="text-[10px] text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-3 py-1.5 text-right text-sky-400">{expanded ? <X size={12} /> : "▸"}</td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/40 bg-background/50">
          <td colSpan={14} className="px-4 py-3">
            {busy && <div className="flex items-center gap-2 py-4 text-xs text-sky-400"><Loader2 size={12} className="animate-spin" /> 拉取成分股…</div>}
            {!busy && error && <div className="py-4 text-xs text-red-300">{error}</div>}
            {!busy && !error && members && (
              <div className="max-h-80 overflow-y-auto desk-scroll">
                <table className="w-full text-[11.5px]">
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
                          <td className="px-2.5 py-1 font-mono">{m.symbol}</td>
                          <td className="px-2.5 py-1">{m.name}{m.st && <span className="ml-1 text-[9px] text-amber-400">ST</span>}{m.suspended && <span className="ml-1 text-[9px] text-muted-foreground">停牌</span>}</td>
                          <td className="px-2.5 py-1 text-right"><NumText value={m.price} /></td>
                          <td className="px-2.5 py-1 text-right"><PctText value={m.changePct} /></td>
                          <td className="px-2.5 py-1 text-right"><NumText value={m.amountYi} digits={1} /></td>
                          <td className="px-2.5 py-1 text-right"><NumText value={m.turnover} /></td>
                          <td className="px-2.5 py-1 text-right"><PctText value={m.mainNetYi} suffix="" /></td>
                          <td className="px-2.5 py-1 text-[10px] text-muted-foreground">{m.industry ?? "—"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
