"use client";
// 候选池页面：池列表 + 池详情（冻结原始 vs 验证回填对照，红涨绿跌）
import { useState, useEffect, useCallback } from "react";
import { Snowflake, ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { PctText, NumText } from "../SourceBadge";
import { fetchPoolList, fetchPoolDetail, runPoolVerify, type PoolDetailClient } from "@/lib/desk/quant-api";

type PoolSummary = import("@/lib/desk/quant-api").PoolSummaryClient;
type PoolRow = PoolDetailClient["rows"][number];
type VerifyData = NonNullable<PoolDetailClient["verify"]>;

// §二 测试数据隔离：来源含 test/fixture 的池是功能验证样本，必须显式标识，不得当作正式选股结果展示
const isTestFixturePool = (s?: string) => /test|fixture|冒烟|测试|验证|回填/i.test(s ?? "");

export default function PoolPage() {
  const [view, setView] = useState<"list" | "detail">("list");
  const [pools, setPools] = useState<PoolSummary[]>([]);
  const [detail, setDetail] = useState<PoolDetailClient | null>(null);
  const [loading, setLoading] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState("");
  const [error, setError] = useState("");

  const fetchList = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setPools(await fetchPoolList());
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDetail = useCallback(async (id: string) => {
    setLoading(true);
    setError("");
    setVerifyMsg("");
    try {
      const j = await fetchPoolDetail(id);
      setDetail(j);
      setView("detail");
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchList(); }, [fetchList]);

  const runVerify = async () => {
    if (!detail) return;
    setVerifyBusy(true);
    setVerifyMsg("");
    try {
      const j = await runPoolVerify(detail.pool_id);
      if (j.status === "pending") {
        setVerifyMsg(`待下一交易日（留档日=${detail.as_of}，今天尚无新增日K）`);
      } else {
        setVerifyMsg(`验证完成（${j.verify?.verifiedDate}）`);
        await fetchDetail(detail.pool_id);
      }
    } catch (e) {
      setVerifyMsg(`验证失败：${(e as Error).message}`);
    } finally {
      setVerifyBusy(false);
    }
  };

  // ---------- 列表视图 ----------
  if (view === "list") {
    return (
      <div className="mx-auto max-w-5xl space-y-4 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-bold">候选池</div>
            <div className="text-[11px] text-muted-foreground">冻结后原始结果永不覆盖 · 次日自动验证回填收益</div>
          </div>
          <button onClick={fetchList} disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
          </button>
        </div>

        {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

        {pools.length === 0 && !loading && (
          <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
            暂无冻结候选池 · 在「AI 实时选股」页面筛选后点击「冻结候选池」
          </div>
        )}

        {pools.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-4 py-2.5">池 ID</th>
                  <th className="px-4 py-2.5">交易日</th>
                  <th className="px-4 py-2.5">股票池</th>
                  <th className="px-4 py-2.5 text-right">股票数</th>
                  <th className="px-4 py-2.5 text-center">验证</th>
                  <th className="px-4 py-2.5">来源</th>
                </tr>
              </thead>
              <tbody>
                {pools.map((p) => (
                  <tr key={p.pool_id} onClick={() => fetchDetail(p.pool_id)}
                    className="cursor-pointer border-b border-border/40 hover:bg-sky-500/5">
                    <td className="px-4 py-2 font-mono text-sky-300">{p.pool_id}</td>
                    <td className="px-4 py-2">{p.as_of}</td>
                    <td className="px-4 py-2">{p.universe}</td>
                    <td className="px-4 py-2 text-right font-mono">{p.row_count}</td>
                    <td className="px-4 py-2 text-center">
                      {p.has_verify
                        ? <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">已验证</span>
                        : <span className="text-muted-foreground">待验证</span>}
                    </td>
                    <td className="px-4 py-2 text-[10px] text-muted-foreground">
                      {p.source}
                      {isTestFixturePool(p.source) && (
                        <span className="ml-1 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-400">测试/回填样本·非正式结果</span>
                      )}
                      <div className="text-[9px] opacity-70">{p.data_source ? `数据：${p.data_source}` : "数据源：未记录（旧池）"}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // ---------- 详情视图 ----------
  if (!detail) {
    return (
      <div className="px-6 py-4 text-sm text-muted-foreground">
        <button onClick={() => setView("list")} className="text-sky-400 hover:underline">← 返回列表</button>
      </div>
    );
  }

  const v = detail.verify;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-4">
      <div className="flex items-center gap-3">
        <button onClick={() => { setView("list"); setDetail(null); }}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-sky-300">
          <ArrowLeft size={12} /> 列表
        </button>
        <div className="text-lg font-bold font-mono text-sky-300">{detail.pool_id}</div>
        <span className="text-xs text-muted-foreground">{detail.as_of} · {detail.universe} · {detail.rows.length} 只 · 来源：{detail.source}{detail.data_source ? ` · 数据：${detail.data_source}` : " · 数据源未记录（旧池）"}</span>
      </div>

      {isTestFixturePool(detail.source) && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          测试/回填样本池（source={detail.source}）：用于候选池功能链路验证，非正式选股结果；价格取自冻结时点的真实行情接口，但不代表正式筛选产出。
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={runVerify} disabled={verifyBusy}
          className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-50">
          {verifyBusy ? <Loader2 size={14} className="animate-spin" /> : <Snowflake size={14} />} 执行次日验证
        </button>
        {verifyMsg && <span className="text-xs text-sky-400">{verifyMsg}</span>}
        {v && <span className="text-[10px] text-muted-foreground">上次验证：{v.verifiedDate}</span>}
      </div>

      {detail.price_basis && (
        <div className="rounded-lg border border-border/60 bg-accent/30 px-3 py-1.5 text-[10.5px] text-muted-foreground">
          价格口径：{detail.price_basis}
        </div>
      )}

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

      {/* 冻结原始 vs 验证对照表 */}
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-3 py-2" rowSpan={2}>代码</th>
              <th className="px-3 py-2" rowSpan={2}>名称</th>
              <th className="px-3 py-2 text-right" colSpan={2}>冻结时<span className="ml-1 font-normal opacity-70">（真实价·未复权）</span></th>
              {v && <th className="px-3 py-2 text-center border-l border-border/40" colSpan={6}>次日验证<span className="ml-1 font-normal opacity-70">（K线序列口径，收益同序列内计算）</span></th>}
            </tr>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-3 py-1.5 text-right">现价</th>
              <th className="px-3 py-1.5 text-right">涨跌%</th>
              {v && <>
                <th className="px-3 py-1.5 text-right border-l border-border/40">验证收盘</th>
                <th className="px-3 py-1.5 text-right">1日收益</th>
                <th className="px-3 py-1.5 text-right">5日收益</th>
                <th className="px-3 py-1.5 text-right">MFE</th>
                <th className="px-3 py-1.5 text-right">MAE</th>
                <th className="px-3 py-1.5 text-right">验证涨跌%</th>
              </>}
            </tr>
          </thead>
          <tbody>
            {detail.rows.map((row) => {
              const vs = v?.perSymbol?.[row.symbol];
              return (
                <tr key={row.symbol} className="border-b border-border/40">
                  <td className="px-3 py-1.5 font-mono">{row.symbol}</td>
                  <td className="px-3 py-1.5">{row.name}</td>
                  <td className="px-3 py-1.5 text-right"><NumText value={row.close} /></td>
                  <td className="px-3 py-1.5 text-right"><PctText value={row.changePct} /></td>
                  {v && <>
                    <td className="px-3 py-1.5 text-right border-l border-border/40">
                      {vs ? <NumText value={vs.close} /> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {vs ? <PctText value={vs.ret1d} /> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {vs ? <PctText value={vs.ret5d} /> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {vs ? <span className="text-red-500">{vs.mfe.toFixed(2)}%</span> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {vs ? <span className="text-emerald-500">{vs.mae.toFixed(2)}%</span> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {vs && vs.close && row.close
                        ? <PctText value={((vs.close - row.close!) / row.close!) * 100} />
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                  </>}
                </tr>
              );
            })}
            {detail.rows.length === 0 && (
              <tr><td colSpan={v ? 10 : 4} className="px-3 py-8 text-center text-muted-foreground">池内无候选</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 汇总统计 */}
      {v && Object.keys(v.perSymbol).length > 0 && (
        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 text-[11.5px]">
          <span className="text-muted-foreground">汇总：</span>
          <VerifySummary rows={detail.rows} verify={v} />
        </div>
      )}
    </div>
  );
}

function VerifySummary({ rows, verify }: { rows: PoolRow[]; verify: VerifyData }) {
  const symbols = rows.map((r) => r.symbol);
  let win1 = 0, total1 = 0, sum1 = 0;
  let win5 = 0, total5 = 0, sum5 = 0;
  let maxMfe = -Infinity, minMae = Infinity;

  for (const sym of symbols) {
    const vs = verify.perSymbol[sym];
    if (!vs) continue;
    if (vs.ret1d !== null) {
      total1++;
      sum1 += vs.ret1d;
      if (vs.ret1d > 0) win1++;
    }
    total5++;
    sum5 += vs.ret5d ?? 0;
    if ((vs.ret5d ?? 0) > 0) win5++;
    if (vs.mfe > maxMfe) maxMfe = vs.mfe;
    if (vs.mae < minMae) minMae = vs.mae;
  }

  const avg1 = total1 > 0 ? sum1 / total1 : 0;
  const avg5 = total5 > 0 ? sum5 / total5 : 0;
  const winRate1 = total1 > 0 ? (win1 / total1) * 100 : 0;
  const winRate5 = total5 > 0 ? (win5 / total5) * 100 : 0;

  return (
    <>
      <span>1日胜率 <span className={winRate1 >= 50 ? "text-red-400 font-medium" : "text-emerald-400"}>{winRate1.toFixed(0)}%</span>（{total1}只）</span>
      <span>均收益 <span className={avg1 > 0 ? "text-red-400" : "text-emerald-400"}>{avg1.toFixed(2)}%</span></span>
      <span>5日胜率 <span className={winRate5 >= 50 ? "text-red-400 font-medium" : "text-emerald-400"}>{winRate5.toFixed(0)}%</span></span>
      <span>5日均 <span className={avg5 > 0 ? "text-red-400" : "text-emerald-400"}>{avg5.toFixed(2)}%</span></span>
      <span>最大MFE <span className="text-red-400">{isFinite(maxMfe) ? maxMfe.toFixed(2) + "%" : "—"}</span></span>
      <span>最大MAE <span className="text-emerald-400">{isFinite(minMae) ? minMae.toFixed(2) + "%" : "—"}</span></span>
    </>
  );
}
