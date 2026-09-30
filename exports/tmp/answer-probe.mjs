// 拿正文：流式调 chat，收集所有 delta，末尾输出全文并检查关键词（验证 sector_breadth 端到端）
const Q =
  process.argv[2] ||
  "帮我看一下半导体板块的资金流、均线广度占比和情绪强弱，目前处于什么阶段、是否值得观察？";
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
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let content = "";
const steps = [];
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const line = frame.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    try {
      const ev = JSON.parse(line.slice(6));
      if (ev.type === "delta" && ev.data && ev.data.content) content += ev.data.content;
      if (ev.type === "step") steps.push(ev.data.step + " " + ev.data.label + " " + ev.data.status + " " + (ev.data.ms ?? "-"));
    } catch {}
  }
}
console.log("=== steps ===");
steps.forEach((s) => console.log("  " + s));
console.log("=== 正文长度 =", content.length, "===");
const fs = await import("node:fs");
fs.writeFileSync("exports/tmp/answer-body.txt", content);
for (const k of ["均线广度", "广度占比", "暂无均线", "站上", "暂无数据"]) {
  const idx = content.indexOf(k);
  console.log("[" + k + "]", idx >= 0 ? "出现 → …" + content.slice(Math.max(0, idx - 50), idx + 120).replace(/\n/g, " ") : "未出现");
}
