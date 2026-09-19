"use client";
// 行业板块排行（P1-2，需求文档 三十四）：板块榜 + 点击展开成分股 + 跳个股画像
// REAL_DATA_ONLY：现有封装取不到的列显式「暂无数据」，不做演示兜底。
import { useState, useEffect, useCallback } from "react";
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

  const [list, setList] = useState<SectorRow[] | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [asOf, setAsOf] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openBoard, setOpenBoard] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [membersBusy, setMembersBusy] = useState(false);
  const [membersError, setMembersError] = useState("");

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/market/sectors");
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "板块榜获取失败");
      setList(j.list ?? []);
      setMissing(j.missing ?? []);
      setAsOf(j.as_of ?? "");
    } catch (e) {
      setError(String((e as Error).message || e));
      setList(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openMembers = async (code: string) => {
    if (openBoard === code) { setOpenBoard(null); setMembers(null); return; }
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
  };

  const openProfile = (symbol: string) => { setFocusSymbol(symbol); go("profile"); };
  const boardName = list?.find((b) => b.code === openBoard)?.name ?? openBoard;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold"><LayoutGrid size={18} className="text-sky-400" /> 行业板块排行</div>
          <div className="text-[11px] text-muted-foreground">
            东财板块榜（主力资金口径合并流入/流出两侧）· 点板块行展开成分股 · 点个股跳画像 · {asOf ? `更新 ${asOf}` : ""}
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
                  onToggle={() => openMembers(b.code)} onOpenProfile={openProfile} />
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
        <td className="px-3 py-1.5 text-right"><PctText value={board.main} suffix="" /></td>
        <td className="px-3 py-1.5 text-right"><NumText value={board.ratio} /></td>
        <td className="px-3 py-1.5 text-right"><NumText value={board.superBig} digits={2} /></td>
        <td className="px-3 py-1.5 text-right"><NumText value={board.big} digits={2} /></td>
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
