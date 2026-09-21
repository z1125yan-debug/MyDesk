"use client";
// 行业板块排行（P1-2，需求文档 三十四）：板块榜 + 点击展开成分股 + 跳个股画像
// REAL_DATA_ONLY：现有封装取不到的列显式「暂无数据」，不做演示兜底。
import { useState, useEffect, useCallback, useRef } from "react";
import { LayoutGrid, Loader2, RefreshCw, X } from "lucide-react";
import { PctText, NumText } from "../SourceBadge";
import { useDesk } from "@/lib/desk/store";

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

  const [list, setList] = useState<SectorRow[] | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [asOf, setAsOf] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  const openMembers = useCallback(async (code: string) => {
    setOpenBoard(code); setMembers(null); setMembersError(""); setMembersBusy(true);
    try {
      const res = await fetch(`/api/market/sectors/${encodeURIComponent(code)}`);
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "成分股获取失败");
      setMembers(j.list ?? []);
    } catch (e) {
      setMembersError(String((e as Error).message || e));
      setMembers(null);
    } finally {
      setMembersBusy(false);
    }
  }, []);
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
      const res = await fetch("/api/market/sectors");
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "板块榜获取失败");
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
  }, [settleJump]);

  useEffect(() => { load(); }, [load]);

  // 为什么只在这里结算、不给 store 加订阅：板块页是 `page === "sectors"` 才挂载的（AppShell 里条件渲染），
  // 而带可点正文的两个入口（助手页、分析页小窗）都在别的页面上——点链接必然是「先切页、后挂载」，
  // 挂载必然带上一次 load()，交接就在那里结算。哪天板块页改成常驻渲染、或本页上出现了对话面，
  // 这里才需要补一个订阅；现在写订阅就是给不存在的场景写代码。
  const openProfile = (symbol: string) => { setFocusSymbol(symbol); go("profile"); };
  const boardName = list?.find((b) => b.code === openBoard)?.name ?? openBoard;

  // 四种结算结果各说一句实话，写在页面上而不是只留在 console
  const jumpNotice = !jump ? ""
    : jump.outcome === "no-list" ? `想定位「${jump.code}」，但板块榜这次没取到${jump.reason ? `（${jump.reason}）` : ""}，未展开任何成分股`
    : jump.outcome === "absent" ? `「${jump.code}」不在当前板块榜（共 ${jump.total ?? 0} 个板块）里，未展开成分股`
    : jump.outcome === "already" ? `已定位到「${jump.name}」（${jump.code}）：该行本来就已展开，未重复开合`
    : `已按对话里的链接展开「${jump.name}」（${jump.code}）的成分股`;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><LayoutGrid size={18} className="text-sky-400" /> 行业板块排行</div>
          <div className="text-[11px] text-muted-foreground">
            {list?.length && list.every((r) => r.fundsMissing)
              ? "腾讯板块兜底榜（东财板块榜断源：涨幅口径，无主力资金读数）"
              : "东财板块榜（主力资金口径合并流入/流出两侧）"}
            {" · 点板块行展开成分股 · 点个股跳画像 · "}{asOf ? `更新 ${asOf}` : ""}
          </div>
        </div>
        <button onClick={load} disabled={busy}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
        </button>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}（数据源失败时不展示任何假数据）</div>}
      {missing.length > 0 && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[10.5px] leading-5 text-amber-300/90">
          暂无数据列（现有数据源封装不含该字段，拒绝演示兜底）：{missing.join("；")}。RPS 为榜单内涨幅百分位，非全市场口径。
        </div>
      )}
      {/* P7-⑧②：从对话正文点板块名跳过来时把结果写明白（命中/已展开过/查无此板块/榜单没取到），不做静默跳转 */}
      {jumpNotice && (
        <div className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[11px] text-sky-200">
          <span className="flex-1">{jumpNotice}</span>
          <button onClick={() => setJump(null)} aria-label="关闭跳转提示" className="text-muted-foreground hover:text-sky-300">
            <X size={12} />
          </button>
        </div>
      )}

      {list && (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                {["#", "板块", "涨幅%", "主力净额(亿)", "净占比%", "超大单(亿)", "大单(亿)", "RPS(榜内)", "领涨股", "成交额", "上涨/涨停家数", "持续天数", ""].map((h) => (
                  <th key={h} className="px-3 py-2">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((b, i) => (
                <SectorBlock key={b.code} rank={i + 1} board={b}
                  expanded={openBoard === b.code}
                  busy={membersBusy} error={membersError} members={members}
                  onToggle={() => (openBoard === b.code ? closeBoard() : void openMembers(b.code))} onOpenProfile={openProfile} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!list && !busy && !error && (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">暂无数据</div>
      )}
    </div>
  );
}

function SectorBlock({ rank, board, expanded, busy, error, members, onToggle, onOpenProfile }: {
  rank: number; board: SectorRow; expanded: boolean;
  busy: boolean; error: string; members: MemberRow[] | null;
  onToggle: () => void; onOpenProfile: (s: string) => void;
}) {
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer border-b border-border/40 hover:bg-sky-500/5">
        <td className="px-3 py-1.5 font-mono text-muted-foreground">{rank}</td>
        <td className="px-3 py-1.5 font-medium">{board.name}<span className="ml-1 text-[10px] text-muted-foreground">{board.code}</span></td>
        <td className="px-3 py-1.5 text-right"><PctText value={board.changePct} /></td>
        <td className="px-3 py-1.5 text-right">{board.fundsMissing ? <span className="text-muted-foreground">—</span> : <PctText value={board.main} suffix="" />}</td>
        <td className="px-3 py-1.5 text-right">{board.fundsMissing ? <span className="text-muted-foreground">—</span> : <NumText value={board.ratio} />}</td>
        <td className="px-3 py-1.5 text-right">{board.fundsMissing ? <span className="text-muted-foreground">—</span> : <NumText value={board.superBig} digits={2} />}</td>
        <td className="px-3 py-1.5 text-right">{board.fundsMissing ? <span className="text-muted-foreground">—</span> : <NumText value={board.big} digits={2} />}</td>
        <td className="px-3 py-1.5 text-right"><NumText value={board.rps} digits={0} /></td>
        <td className="px-3 py-1.5 text-[11px]">{board.leader || "—"}</td>
        <td className="px-3 py-1.5 text-center text-[10px] text-muted-foreground">暂无数据</td>
        <td className="px-3 py-1.5 text-center text-[10px] text-muted-foreground">暂无数据</td>
        <td className="px-3 py-1.5 text-center text-[10px] text-muted-foreground">暂无数据</td>
        <td className="px-3 py-1.5 text-right text-sky-400">{expanded ? <X size={12} /> : "▸"}</td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/40 bg-background/50">
          <td colSpan={13} className="px-4 py-3">
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
