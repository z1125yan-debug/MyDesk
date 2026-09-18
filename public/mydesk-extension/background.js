// MyDesk 行情助手后台：转发内容脚本的发送请求（避开页面 CSP 限制）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "mydesk-send") return false;
  fetch(msg.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg.payload),
  })
    .then((r) => sendResponse({ ok: r.ok }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});
