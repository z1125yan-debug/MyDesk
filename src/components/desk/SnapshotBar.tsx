"use client";
// 每日留档条（P5 第五阶段）：Risk / Themes / Probability 三页共用。
//
// 口径纪律（REAL_DATA_ONLY）：
// - 本组件不发任何结果数字：点「留档今天」只是 POST 一个留档意图，服务端当场调用**页面同源的**计算链路
//   重算一次再落库（概率页额外带上「这次用的是哪一组条件」，因为胜率离开条件就没有意义）；
// - 清单、摘要、日期、缺失口径全部来自 /api/snapshot 的真实返回，组件自己不数、不补、不四舍五入；
// - 留档只在点击时发生：本页没有调度器、没有「每天自动留档」，所以文案里也不出现这类说法；
// - 某天没留过就显示「没有留档行」，绝不拿别的日子或现算结果顶上（与第四阶段历史查询同一条规矩）。
import { useCallback, useEffect, useState } from "react";
import { Archive, CalendarDays, Loader2 } from "lucide-react";
import { SourceBadge } from "./SourceBadge";
import {
  archiveSnapshotApi, fetchSnapshots,
  type SnapshotKindClient, type SnapshotRespClient,
} from "@/lib/desk/quant-api";

export function SnapshotBar({
  kind, label, sideEffect, getRequest,
}: {
  kind: SnapshotKindClient;
  /** 页面名，只用于按钮文案，不参与任何判定 */
  label: string;
  /** 留档的副作用说明：这一下会真的重新拉一次行情/重算 */
  sideEffect: string;
  /** 概率页专用：把「当次计算用的那组条件」交给服务端一起存。返回 null = 还没有可留档的计算 */
  getRequest?: () => Record<string, unknown> | null;
}) {
  const [resp, setResp] = useState<SnapshotRespClient | null>(null);
  const [date, setDate] = useState("");
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedNote, setSavedNote] = useState("");

  const load = useCallback(async (d = "") => {
    setBusy(true); setError("");
    try { setResp(await fetchSnapshots(kind, d)); setDate(d); }
    catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }, [kind]);
  useEffect(() => { void load(); }, [load]);

  const req = getRequest?.() ?? null;
  const blocked = !!getRequest && !req;

  const save = async () => {
    setSaving(true); setError(""); setSavedNote("");
    try {
      const r = await archiveSnapshotApi(kind, getRequest ? req : undefined);
      setSavedNote(`已新增一条留档（${r.computed_at}，留档日 ${r.trade_date}）：${r.headline}`);
      await load("");
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally { setSaving(false); }
  };

  const dates = resp?.available_dates ?? [];
  // 元信息没读回来之前不能断言「一条留档都没有」：那是把「还没查到」说成「查过了、没有」
  const sumText = !resp ? "留档清单读取中…"
    : resp.counts.total === 0 ? "库里还没有任何留档行"
      : `共 ${resp.counts.total} 条留档 · 覆盖 ${resp.counts.days} 个留档日 · 本次返回 ${resp.counts.returned} 条`;

  return (
    <div className="space-y-2 rounded-xl border border-border bg-card/60 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="inline-flex items-center gap-1 text-muted-foreground"><Archive size={12} /> 每日留档</span>
        <button onClick={save} disabled={saving || busy || blocked}
          title={blocked ? "还没有可留档的计算结果：先完成一次计算再留档（留档存的就是这一次的结果）" : sideEffect}
          className="flex items-center gap-1 rounded-md border border-sky-500/50 bg-sky-500/15 px-2 py-1 text-sky-200 hover:bg-sky-500/25 disabled:opacity-40">
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Archive size={11} />}
          {saving ? "留档中（服务端重算）" : `留档今天${label ? `（${label}）` : ""}`}
        </button>
        <button onClick={() => void load("")} disabled={busy || saving}
          className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:border-sky-500/40">
          {resp?.date ? "回到最近留档" : "刷新留档清单"}
        </button>
        <input type="date" value={pick} max={resp?.today || undefined} disabled={busy || saving}
          onChange={(e) => setPick(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1 text-[12px]" />
        <button onClick={() => pick && void load(pick)} disabled={busy || saving || !pick}
          className="inline-flex items-center gap-1 rounded-md bg-sky-500/90 px-2 py-1 text-[12px] text-white hover:bg-sky-400 disabled:opacity-50">
          <CalendarDays size={11} /> 看指定留档日
        </button>
        <span className="text-[11.5px] text-muted-foreground">{sumText}</span>
        {busy && <span className="text-[11.5px] text-muted-foreground">读取中…</span>}
      </div>

      {!!dates.length && (
        <div className="flex flex-wrap gap-1 text-[11px] text-muted-foreground/80">
          已有留档日（倒序，括号内为当天条数）：
          {dates.slice(0, 12).map((d) => (
            <button key={d.date} onClick={() => void load(d.date)} disabled={busy || saving}
              title={`查看 ${d.date} 的留档（${d.count} 条）`}
              className={`rounded border px-1.5 py-0.5 ${date === d.date ? "border-sky-500/50 text-sky-200" : "border-border hover:border-sky-500/40"}`}>
              {d.date}({d.count})
            </button>
          ))}
          {dates.length > 12 && <span>…另 {dates.length - 12} 个留档日未列出（接口已返回全部日期计数）</span>}
        </div>
      )}

      {resp && (
        <div className="flex flex-wrap items-center gap-2">
          <SourceBadge status={resp.date ? "ARCHIVED 留档回看" : "ARCHIVED 最近留档"}
            source={`只读「${label}」留档：${resp.date ? `留档日 ${resp.date}` : "最近若干条（按留档时间从新到旧）"}`}
            time={resp.date ?? ""} />
          <span className="text-[11px] text-muted-foreground">{resp.date_basis}</span>
        </div>
      )}

      {resp?.items.length ? (
        <ul className="space-y-1">
          {resp.items.map((it) => (
            <li key={it.id} className="rounded-md border border-border/70 bg-background/40 px-2 py-1.5 text-[11.5px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">留档时间 <b className="text-foreground">{it.computed_at}</b></span>
                <span className="text-muted-foreground">留档日 {it.trade_date}</span>
                {it.payload_broken && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300"
                    title="存的原文不是合法 JSON：摘要只能按可读部分给出，损坏处不修补、不重算代替">
                    留档内容损坏
                  </span>
                )}
              </div>
              <div className="mt-0.5 leading-4">{it.headline}</div>
              {!!it.missing.length && <div className="mt-0.5 text-muted-foreground/80">当次缺失：{it.missing.join("；")}</div>}
              <div className="mt-0.5 text-muted-foreground/60">来源：{it.source || "—"}</div>
            </li>
          ))}
        </ul>
      ) : resp && !busy ? (
        <div className="text-[11.5px] text-muted-foreground">
          {resp.missing.length ? resp.missing.join("；") : "没有可读回的留档行（本次查询返回 0 条，且未给出原因）"}
        </div>
      ) : null}

      {savedNote && (
        <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2 py-1 text-[11.5px] text-emerald-300/90">{savedNote}</div>
      )}
      {error && <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11.5px] text-red-300">{error}</div>}

      <div className="text-[11px] leading-4 text-muted-foreground/70">
        口径：{resp?.basis ?? "留档口径读取中…（下面这段是本页的固定说明）"}
        {" "}{sideEffect}
        {" "}本页没有调度器：留档只在点上面那个按钮时发生，不点就不会有那天的行，也不会自动补。
      </div>
    </div>
  );
}
