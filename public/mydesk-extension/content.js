// MyDesk 行情助手内容脚本：在 TradingView 图表页加一个悬浮按钮
function extractSymbol() {
  const url = location.href;
  const m = url.match(/symbol=([A-Za-z0-9_:.]+)/) || url.match(/\/symbols\/[A-Za-z0-9\-]*?([A-Z]{2,10}[A-Z0-9:\.]+)\/?/);
  return m ? m[1].replace(/[:\.]$/, "") : "";
}

function mountButton() {
  if (document.getElementById("mydesk-float")) return;
  const btn = document.createElement("button");
  btn.id = "mydesk-float";
  btn.textContent = "→ MyDesk";
  btn.title = "把当前品种发送到本地 MyDesk 行情工作台";
  btn.addEventListener("click", async () => {
    const symbol = extractSymbol();
    if (!symbol) { btn.textContent = "未识别品种"; setTimeout(() => (btn.textContent = "→ MyDesk"), 1500); return; }
    const { endpoint, key } = await chrome.storage.local.get(["endpoint", "key"]);
    const ep = endpoint || "http://localhost:3000/api/extension/pending";
    chrome.runtime.sendMessage(
      { type: "mydesk-send", endpoint: ep, payload: { symbol, chartUrl: location.href, key, ts: Date.now() } },
      (res) => {
        btn.textContent = res?.ok ? "已发送 ✓" : "发送失败";
        setTimeout(() => (btn.textContent = "→ MyDesk"), 1500);
      }
    );
  });
  document.body.appendChild(btn);
}

mountButton();
setInterval(mountButton, 3000);
