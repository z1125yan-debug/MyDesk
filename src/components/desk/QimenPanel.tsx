"use client";
// P7-⑨⑤ 奇门解盘面板 —— 智能助手页 deskMode==="qimen" 时整块替换对话区。
//
// 这一屏的渲染纪律（改之前先读完）：
// 1) **盘不自己排**：九宫、四柱、局数、节气全部来自 GET /api/qimen/chart 的真实计算结果（服务端调本地开源库），
//    前端一个字段都不重算、不补默认值。接口回了 missing 就如实写「本次未取到」，绝不画一个假盘顶上。
// 2) **解盘走既有模型通道**：复用 @/lib/desk/ai 的 aiChat（→ /api/ai/proxy），Key 只存在浏览器 localStorage，
//    这里不新建第二条模型路径、不读用户 Key、不把 Key 落进任何状态或日志。AI 没配置就明说，不伪造解盘文本。
// 3) **分层标注**：排盘事实（术数推演）≠ 市场事实 ≠ 投资建议，三者在界面上分开写清，解盘卡恒带一句免责声明。
// 4) 问题类型只从白名单下拉选，用户自由文本不进 prompt（内核 buildInterpretPrompt 已固定模板）。
import { useCallback, useState } from "react";
import { Loader2, Sparkles, Compass } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { DeskCollapse } from "@/components/desk/ui/DeskCollapse";
import { aiChat, aiReady } from "@/lib/desk/ai";
import { MISSING_TEXT } from "@/lib/desk/context-panel-core";
import {
  CITIES, QUESTION_TYPES, QIMEN_SYSTEM_PROMPT, buildInterpretPrompt, parseInterpretation, provenanceLine,
  type Interpretation, type QimenChart, type QimenPalace,
} from "@/lib/qimen/qimen-core";

/** 起局表单的可选项全部来自内核那份唯一清单，界面不另抄一份（少一个城市/问题类型都会立刻看出来） */
const DEFAULT_CITY = CITIES[0]?.name ?? "北京";
const DEFAULT_QT = QUESTION_TYPES[0]?.value ?? "decision";

export default function QimenPanel() {
  const ai = useDesk((s) => s.ai);
  const go = useDesk((s) => s.go);
  const configured = aiReady(ai);

  // 表单：日期/时间留空＝服务端用当前北京时间起局（不接受客户端伪造的「现在」）
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [city, setCity] = useState(DEFAULT_CITY);
  const [questionType, setQuestionType] = useState(DEFAULT_QT);
  const [tst, setTst] = useState(true);

  const [casting, setCasting] = useState(false);
  const [chart, setChart] = useState<QimenChart | null>(null);
  const [castError, setCastError] = useState<string | null>(null);
  const [castDetail, setCastDetail] = useState<string | null>(null);
  const [qtNote, setQtNote] = useState<string | null>(null);

  const [interpreting, setInterpreting] = useState(false);
  const [interp, setInterp] = useState<Interpretation | null>(null);
  const [interpError, setInterpError] = useState<string | null>(null);

  const cast = useCallback(async () => {
    setCasting(true);
    setCastError(null); setCastDetail(null); setQtNote(null);
    // 换盘就要清掉上一盘的解盘：留着旧解盘配新盘面＝把两个时刻的结论混成一张
    setInterp(null); setInterpError(null);
    const sp = new URLSearchParams();
    if (date.trim()) sp.set("date", date.trim());
    if (time.trim()) sp.set("time", time.trim());
    sp.set("city", city);
    sp.set("question_type", questionType);
    sp.set("tst", tst ? "1" : "0");
    try {
      const res = await fetch(`/api/qimen/chart?${sp.toString()}`);
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean; chart?: QimenChart; error?: string; detail?: string | null; note?: string;
      };
      if (!res.ok || !json.ok || !json.chart) {
        setChart(null);
        setCastError(json.error || `起局失败（HTTP ${res.status}）`);
        setCastDetail(json.detail ?? null);
        return;
      }
      setChart(json.chart);
      setQtNote(json.note ?? null);
    } catch (e) {
      setChart(null);
      setCastError(`起局请求未能完成：${(e as Error).message}`);
    } finally {
      setCasting(false);
    }
  }, [date, time, city, questionType, tst]);

  const interpret = useCallback(async () => {
    if (!chart) return;
    setInterpreting(true); setInterpError(null); setInterp(null);
    try {
      // 不带 scene：这是一次纯粹的「按固定模板解这个盘」，不走对话的意图识别/工具环，
      // 服务端只把两条 message 原样转发给所选服务商。
      const text = await aiChat(ai, [
        { role: "system", content: QIMEN_SYSTEM_PROMPT },
        { role: "user", content: buildInterpretPrompt(chart) },
      ], { timeoutMs: 60000 });
      setInterp(parseInterpretation(text));
    } catch (e) {
      setInterpError(`解盘文本${MISSING_TEXT}：调用模型通道失败（${(e as Error).message}）。排盘结果不受影响，可重试。`);
    } finally {
      setInterpreting(false);
    }
  }, [ai, chart]);

  return (
    <div className="desk-scroll flex min-h-0 flex-1 w-full flex-col gap-4 overflow-y-auto">
      {/* ---------- 起局表单 ---------- */}
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-rose-600">
            <Compass size={15} className="text-white" />
          </div>
          <div>
            <div className="text-[14px] font-semibold">奇门遁甲 · 时家起局</div>
            <div className="text-[11px] text-muted-foreground">本地开源引擎排盘（不发外部请求）；解盘文本另走已配置的模型通道</div>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="日期（北京时间）">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-[13px] outline-none focus:border-amber-500/60" />
          </Field>
          <Field label="时间">
            <input type="time" step={60} value={time} onChange={(e) => setTime(e.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-[13px] outline-none focus:border-amber-500/60" />
          </Field>
          <Field label="城市（内置经纬度）">
            <select value={city} onChange={(e) => setCity(e.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-[13px] outline-none focus:border-amber-500/60">
              {CITIES.map((c) => <option key={c.name} value={c.name}>{c.name}（{c.kind}）</option>)}
            </select>
          </Field>
          <Field label="问题类型">
            <select value={questionType} onChange={(e) => setQuestionType(e.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-[13px] outline-none focus:border-amber-500/60">
              {QUESTION_TYPES.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
            </select>
          </Field>
          <label className="flex h-9 cursor-pointer items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <input type="checkbox" checked={tst} onChange={(e) => setTst(e.target.checked)} className="accent-amber-500" />
            真太阳时校正
          </label>
          <button onClick={() => void cast()} disabled={casting}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-amber-500/90 px-4 text-[13px] font-medium text-white hover:bg-amber-500 disabled:opacity-50">
            {casting ? <Loader2 size={14} className="animate-spin" /> : <Compass size={14} />} 起局
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground/85">
          日期或时间留空＝按服务端当前北京时间起局（不接受浏览器伪造的「现在」）。晚子时口径固定为「当日起日柱」（same-day）。
        </p>
      </section>

      {/* ---------- 起局失败 ---------- */}
      {castError && (
        <section className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-[13px] text-amber-200">
          <div className="font-medium">{castError}</div>
          {castDetail && <div className="mt-1 text-[11.5px] text-amber-200/80">细节：{castDetail}</div>}
        </section>
      )}

      {/* ---------- 尚未起局 ---------- */}
      {!chart && !castError && (
        <section className="rounded-xl border border-dashed border-border bg-card/50 p-8 text-center text-[13px] text-muted-foreground">
          选好时间、城市与问题类型，点「起局」。盘面全部由本地开源引擎实算，不会用演示数据顶替。
        </section>
      )}

      {/* ---------- 盘面 ---------- */}
      {chart && (
        <>
          {qtNote && (
            <div className="rounded-lg border border-border bg-accent/30 px-3 py-2 text-[11.5px] text-muted-foreground">{qtNote}</div>
          )}
          <FactsCard chart={chart} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
            <PalaceGrid chart={chart} />
            <InterpretCard
              configured={configured}
              interpreting={interpreting}
              interp={interp}
              interpError={interpError}
              onInterpret={() => void interpret()}
              onConfigure={() => go("settings")}
            />
          </div>
          <Provenance chart={chart} />
        </>
      )}
    </div>
  );
}

// ---------- 子块 ----------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** 四柱 / 局数 / 节气 / 值符值使 / 空亡 / 真太阳时 / 提示 —— 全是接口回来的真实字段，逐项照读 */
function FactsCard({ chart }: { chart: QimenChart }) {
  const c = chart.chart;
  const cal = chart.calendar;
  const tst = cal.true_solar_time;
  const gz = chart.ganzhi;
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-amber-500/15 px-2.5 py-1 text-[14px] font-semibold text-amber-300">{c.full_name}</span>
        <span className="text-[12px] text-muted-foreground">节气 {c.jieqi}</span>
        <span className="text-[12px] text-muted-foreground">值符 {c.zhifu}</span>
        <span className="text-[12px] text-muted-foreground">值使 {c.zhishi}</span>
        <span className="text-[12px] text-muted-foreground">{c.kong_kind}空亡 {c.kong}</span>
        <span className="text-[12px] text-muted-foreground">旬首 {c.xunshou}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-4">
        <KV k="年柱" v={gz.year} /><KV k="月柱" v={gz.month} />
        <KV k="日柱" v={gz.day} /><KV k="时柱" v={gz.hour} />
        <KV k="日旬" v={gz.day_xun} /><KV k="时旬" v={gz.hour_xun} />
        <KV k="起局（北京时间）" v={`${cal.solar.date} ${cal.solar.time}`} />
        <KV k="农历" v={cal.lunar ?? MISSING_TEXT} note={cal.lunar_note ?? undefined} />
      </div>
      <div className="mt-2.5 border-t border-border/70 pt-2.5 text-[11.5px] leading-5 text-muted-foreground">
        {tst.enabled ? (
          <span>
            真太阳时：<span className="text-foreground">{tst.corrected}</span>
            （东经 {tst.longitude}°，经度差 {tst.longitudeMinutes.toFixed(1)} 分 + 均时差 {tst.equationOfTimeMinutes.toFixed(1)} 分 = 偏移 {tst.offsetMinutes.toFixed(1)} 分）
            {tst.hourPillarChanged && tst.beijingHourPillar && (
              <span className="ml-1 text-amber-300">校正跨了时辰：北京时间原为 {tst.beijingHourPillar} 时，校正后为 {gz.hour} 时</span>
            )}
          </span>
        ) : (
          <span>真太阳时：未启用，按北京时间起局</span>
        )}
      </div>
      {chart.warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {chart.warnings.map((w, i) => (
            <li key={i} className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] leading-5 text-amber-200">{w}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function KV({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <div className="flex items-baseline gap-1.5" title={note}>
      <span className="shrink-0 text-[11px] text-muted-foreground">{k}</span>
      <span className="truncate font-medium text-foreground">{v || MISSING_TEXT}</span>
    </div>
  );
}

/** 九宫盘：按接口回来的 grid（洛书顺序三行宫号）照画，每格读 palace 里的真实字段，中宫特殊标 */
function PalaceGrid({ chart }: { chart: QimenChart }) {
  const byNo = (p: number) => chart.chart.palaces.find((x) => x.palace === p) ?? null;
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 text-[13px] font-semibold text-muted-foreground">九宫盘面（洛书顺序）</div>
      <div className="grid grid-cols-3 gap-2">
        {chart.chart.grid.flat().map((p) => {
          const x = byNo(p);
          return <PalaceCell key={p} p={x} />;
        })}
      </div>
      <p className="mt-3 text-[10.5px] leading-4 text-muted-foreground/80">
        天＝天盘干，地＝地盘干，暗＝暗干。中宫无星门神，其地盘干寄于承宫（见表内标注）。「空」为旬空、「马」为驿马，均按开源库本次输出原样透出。
      </p>
    </section>
  );
}

function PalaceCell({ p }: { p: QimenPalace | null }) {
  if (!p) return <div className="rounded-lg border border-border/50 bg-accent/10 p-2 text-[11px] text-muted-foreground">缺{MISSING_TEXT}</div>;
  const markers = [...p.day_marker.map((m) => `日${m}`), ...p.hour_marker.map((m) => `时${m}`)];
  return (
    <div className={"flex min-h-[7.5rem] flex-col gap-1 rounded-lg border p-2 text-[11.5px] leading-4 " +
      (p.is_center ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-background/60")}>
      <div className="flex items-baseline justify-between gap-1">
        <span className="font-semibold text-foreground">{p.name}{p.palace}宫</span>
        <span className="text-[10px] text-muted-foreground">{p.direction}</span>
      </div>
      <Line k="天" v={p.sky_stems.join(" ")} />
      <Line k="地" v={p.earth_stems.join(" ")} />
      <div className="flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
        <span>{p.star || "—"}</span><span>{p.door || "—"}</span><span>{p.god || "—"}</span>
      </div>
      <Line k="暗" v={p.ang_gan} />
      {(p.is_center || p.hosts_center || p.hosts_sky_center) && (
        <div className="text-[10px] leading-4 text-amber-300/90">
          {p.is_center && <div>中宫（无星门神）</div>}
          {p.hosts_center && <div>承中宫地盘干</div>}
          {p.hosts_sky_center && <div>禽芮同宫·承中宫天盘干</div>}
        </div>
      )}
      {markers.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1">
          {markers.map((m, i) => (
            <span key={i} className="rounded border border-sky-500/30 bg-sky-500/10 px-1 text-[9.5px] leading-4 text-sky-300">{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="shrink-0 text-[10px] text-muted-foreground">{k}</span>
      <span className="font-medium text-foreground">{v || "—"}</span>
    </div>
  );
}

/** 解盘卡：走既有模型通道生成，永远带「术数推演≠市场事实≠投资建议」的定性 */
function InterpretCard(props: {
  configured: boolean; interpreting: boolean; interp: Interpretation | null; interpError: string | null;
  onInterpret: () => void; onConfigure: () => void;
}) {
  const { configured, interpreting, interp, interpError, onInterpret, onConfigure } = props;
  return (
    <section className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Sparkles size={14} className="text-amber-300" /> AI 解盘
        </div>
        {configured ? (
          <button onClick={onInterpret} disabled={interpreting}
            className="inline-flex items-center gap-1.5 rounded-md bg-sky-500/90 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-sky-500 disabled:opacity-50">
            {interpreting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {interp ? "重新解盘" : "生成解盘"}
          </button>
        ) : (
          <button onClick={onConfigure}
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-300 hover:bg-amber-500/20">
            先去配置 AI
          </button>
        )}
      </div>

      {!configured && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11.5px] leading-5 text-amber-200">
          没有可用的模型通道（浏览器未配置，且服务端 .env 通道不可用），解盘文本{MISSING_TEXT}。排盘本身不依赖模型，盘面照常可用；配好任一条路后回来点「生成解盘」。
        </p>
      )}
      {interpError && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11.5px] leading-5 text-amber-200">{interpError}</p>
      )}
      {interpreting && !interp && (
        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><Loader2 size={13} className="animate-spin" /> 正在按固定模板解这个盘…</p>
      )}

      {interp && (
        <div className="space-y-2.5">
          {interp.parsed ? (
            <>
              <Seg title="核心结论" body={interp.core} />
              <Seg title="操作建议" body={interp.advice} />
              <Seg title="风险提示" body={interp.risk} tone="amber" />
            </>
          ) : (
            <div className="rounded-md border border-border/70 bg-accent/20 px-2.5 py-2">
              <div className="mb-1 text-[10.5px] text-muted-foreground">模型未按三段格式返回，原文整段如下（不硬切成假标题）：</div>
              <div className="whitespace-pre-wrap text-[12.5px] leading-6 text-foreground">{interp.full || MISSING_TEXT}</div>
            </div>
          )}
        </div>
      )}

      <p className="mt-3 border-t border-border/70 pt-2.5 text-[10.5px] leading-4 text-muted-foreground/85">
        解盘为传统术数推演，由已配置的模型通道生成，<span className="text-amber-300">不是市场事实、不是研究结论、不构成投资建议</span>；只使用了本次盘面的真实字段，不含任何价位或涨跌幅承诺。
      </p>
    </section>
  );
}

function Seg({ title, body, tone }: { title: string; body: string; tone?: "amber" }) {
  const head = tone === "amber" ? "text-amber-300" : "text-sky-300";
  return (
    <div className="rounded-md border border-border/70 bg-accent/20 px-2.5 py-2">
      <div className={"mb-1 text-[11px] font-medium " + head}>{title}</div>
      <div className="whitespace-pre-wrap text-[12.5px] leading-6 text-foreground">{body || MISSING_TEXT}</div>
    </div>
  );
}

/** 出处块：引擎/版本/方法/起局口径/生成时刻，与全站「每块数据都能说出自己从哪来」的口径一致 */
function Provenance({ chart }: { chart: QimenChart }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 text-[11px] leading-5 text-muted-foreground">
      <div className="mb-1.5 text-[12px] font-medium text-foreground">起局口径与出处</div>
      <div>{provenanceLine(chart)}</div>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
        {chart.provenance.rules.map((r, i) => <li key={i}>{r}</li>)}
      </ul>
      <DeskCollapse
        className="mt-2.5"
        title="查看开源库原始输出（raw）"
        triggerClassName="text-[11.5px] text-sky-300 hover:text-sky-200"
        contentClassName="text-[10.5px] text-muted-foreground"
      >
        <pre className="desk-scroll max-h-80 overflow-auto rounded-md border border-border/70 bg-background/70 p-2 text-[10.5px] leading-4">
{JSON.stringify(chart.raw, null, 2)}
        </pre>
      </DeskCollapse>
    </section>
  );
}
