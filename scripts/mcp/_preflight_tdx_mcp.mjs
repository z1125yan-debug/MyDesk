// R9 预检（走查脚本，不入库）：直连 tdx-mcp stdio，验证工具能不能用 + 是不是实时
// 实时证据法：stock_quotes 连打两次（间隔 ~6s），比对两次返回的时间戳/价格是否推进。
import { spawn } from "child_process";

const UVX = "C:\\Users\\Lenovo\\.local\\bin\\uvx.exe";

const child = spawn(UVX, ["--from", "tdx-mcp", "--with", "mcp<2", "tdx-mcp"], {
  env: { ...process.env, UV_CACHE_DIR: "D:\\Zai\\uv-cache" },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (c) => process.stderr.write(`[tdx-mcp stderr] ${c}`));

let buf = "";
let nextId = 1;
const pending = new Map();

child.stdout.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    } catch { /* 非 JSON 行忽略 */ }
  }
});

function rpc(method, params, ms = 60000) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)); }, ms);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 按 inputSchema 的 required/props 造探针入参（不通用的手工规则放在各工具自己的构造函数里）
function argsFor(name, props, required) {
  const a = {};
  for (const k of required) {
    const p = props[k] ?? {};
    const numeric = p.type === "integer" || p.type === "number";
    if (/code_list|list/i.test(k)) a[k] = [[1, "600977"], [1, "600519"]];
    else if (p.type === "array") a[k] = [[1, "600977"]];
    else if (/(count|limit|num|size)/i.test(k)) a[k] = 5;
    else if (/market/i.test(k) || numeric) a[k] = 1;
    else if (/symbol/i.test(k)) a[k] = "600977.SH";
    else if (/code/i.test(k)) a[k] = "600977";
    else if (p.enum?.length) a[k] = p.enum[0];
    else a[k] = "";
  }
  // 可选参数不填，让服务端用自己的默认
  return a;
}

function brief(result, max = 600) {
  const text = JSON.stringify(result?.content ?? result?.error ?? result ?? {}).replace(/\s+/g, " ");
  return text.slice(0, max);
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mydesk-preflight", version: "0.0.1" },
  });
  console.log("serverInfo:", JSON.stringify(init.result?.serverInfo));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await rpc("tools/list", {});
  const tools = list.result?.tools ?? [];
  console.log(`tools 共 ${tools.length} 个：`, tools.map((t) => t.name).join(", "));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const probes = ["stock_quotes", "symbol_zjlx", "stock_kline", "stock_tick_chart", "get_index_overview"];
  let firstQuoteText = "";
  for (const name of probes) {
    const t = byName[name];
    if (!t) { console.log(`-- ${name}: 工具不存在`); continue; }
    const props = t.inputSchema?.properties ?? {};
    const required = t.inputSchema?.required ?? [];
    console.log(`-- ${name} 入参: props=${JSON.stringify(Object.keys(props))} required=${JSON.stringify(required)}`);
    const args = argsFor(name, props, required);
    if (name === "stock_quotes") args.code_list = [[1, "600977"], [1, "600519"]]; // 形状：[市场, 代码] 元组（1=沪 0=深）
    if (name === "symbol_zjlx") { args.market = 1; args.code = "600977"; }
    if (name === "stock_kline") { args.market = 1; args.code = "600977"; args.period = 4; args.count = 5; } // 4=日线
    if (name === "stock_tick_chart") { args.market = 1; args.code = "600977"; }
    const start = Date.now();
    try {
      const call = await rpc("tools/call", { name, arguments: args }, 90000);
      const ms = Date.now() - start;
      const isErr = call.result?.isError === true;
      console.log(`tools/call ${name} (${ms}ms)${isErr ? " [工具报错]" : ""} ⇒`, brief(call.result ?? call.error));
      if (name === "stock_quotes") firstQuoteText = JSON.stringify(call.result?.content ?? {});
    } catch (e) {
      console.log(`tools/call ${name} ⇒ 异常: ${e.message}`);
    }
  }

  console.log("\n=== 实时探针：6 秒后再打一次 stock_quotes 比对 ===");
  await sleep(6000);
  try {
    const call2 = await rpc("tools/call", { name: "stock_quotes", arguments: { code_list: [[1, "600977"], [1, "600519"]] } }, 90000);
    const secondText = JSON.stringify(call2.result?.content ?? {});
    console.log("第二次(截断):", brief(call2.result ?? {}, 600));
    console.log("两次响应逐字节相同:", firstQuoteText === secondText ? "相同（静态快照/未开盘不推进）" : "不同（数据在推进）");
  } catch (e) {
    console.log("第二次调用失败:", e.message);
  }
  const now = new Date();
  console.log("\n本地时间:", now.toString(), "| UTC:", now.toISOString());
} catch (e) {
  console.error("预检失败:", e.message);
} finally {
  child.kill();
  process.exit(0);
}
