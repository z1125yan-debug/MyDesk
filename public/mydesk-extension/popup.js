// MyDesk 行情助手弹窗：保存回传配置、手动发送当前标签页品种
const $ = (id) => document.getElementById(id);

async function currentSymbol() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";
  // TradingView 常见形态：/chart/?symbol=BINANCE:BTCUSDT 或 /symbols/xxx-BTCUSDT/
  const m = url.match(/symbol=([A-Za-z0-9_:.]+)/) || url.match(/\/symbols\/[A-Za-z0-9\-]*?([A-Z]{2,10}[A-Z0-9:\.]+)\/?/);
  return m ? m[1].replace(/[:\.]$/, "") : "";
}

$("send").addEventListener("click", async () => {
  const endpoint = $("endpoint").value.trim();
  const key = $("key").value.trim();
  if (!endpoint) { $("status").textContent = "请先填写回传地址"; return; }
  const symbol = await currentSymbol();
  if (!symbol) { $("status").textContent = "未能在当前页面识别到品种（请在 TradingView 图表页使用）"; return; }
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, chartUrl: (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url, key, ts: Date.now() }),
    });
    $("status").textContent = res.ok ? `已发送：${symbol}` : "发送失败（MyDesk 是否在运行？）";
  } catch {
    $("status").textContent = "发送失败（MyDesk 是否在运行？）";
  }
});

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ endpoint: $("endpoint").value.trim(), key: $("key").value.trim() });
  $("status").textContent = "配置已保存";
});

chrome.storage.local.get(["endpoint", "key"]).then(({ endpoint, key }) => {
  $("endpoint").value = endpoint || "http://localhost:3000/api/extension/pending";
  $("key").value = key || "";
});
