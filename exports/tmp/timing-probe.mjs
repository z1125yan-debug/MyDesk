// 临时诊断：流式调用对话接口，逐帧打时间戳，定位「快速分析中」卡在哪一阶段。
// 用法：node exports/tmp/timing-probe.mjs [question]
const Q =
  process.argv[2] ||
  "帮我看一下半导体板块现在的资金流向怎么样？请用数据支撑，先给结论再给依据。";

const started = Date.now();
const t0 = () => `${String(Date.now() - started).padStart(6)}ms`;

const res = await fetch("http://127.0.0.1:3000/api/ai/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    messages: [{ role: "user", content: Q }],
    stream: true,
    scene: { focusSymbol: null, sessionSymbol: null, prevScene: null },
    mode: "decision",
  }),
});

console.log(`[${t0()}] HTTP ${res.status} ct=${res.headers.get("content-type")}`);
if (!res.ok || !res.body) {
  const txt = await res.text().catch(() => "");
  console.log("BODY:", txt.slice(0, 400));
  process.exit(1);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let n = 0;
const deadline = Date.now() + 180_000;
try {
  for (;;) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: false, value: null, tick: true }), 5000)),
    ]);
    if (Date.now() > deadline) {
      console.log(`[${t0()}] DEADLINE 180s hit, frames=${n} — 判定为卡住`);
      break;
    }
    if (done) {
      console.log(`[${t0()}] STREAM DONE frames=${n}`);
      break;
    }
    if (value == null) continue; // tick: 无数据到达
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      n++;
      let ev;
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      const d = ev.data ?? {};
      const kind = ev.type;
      const brief =
        kind === "delta"
          ? `chars=${String(d.content ?? "").length}`
          : kind === "step"
            ? `step=${d.step} ${d.label} status=${d.status} ms=${d.ms ?? "-"}`
            : JSON.stringify(d).slice(0, 160);
      // 只打前 3 帧 + 之后每 10 帧 + 所有 step/warning/error/done，避免刷屏
      if (n <= 3 || n % 10 === 0 || kind !== "delta") {
        console.log(`[${t0()}] #${n} ${kind} ${brief}`);
      }
    }
  }
} finally {
  try { await reader.cancel(); } catch {}
}
console.log(`[${t0()}] total frames=${n}`);
