// ⚠️ 此文件仅在 Node 服务端使用（通过 API 路由引用）
// MCP stdio 管理器：spawn 子进程 + JSON-RPC 2024-11-05 握手
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import path from "path";
import type { McpServerConfig, McpToolInfo } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, "mcp-config.json");

interface Runtime {
  child: ChildProcessWithoutNullStreams;
  status: "starting" | "ready" | "failed" | "exited";
  error?: string;
  tools: McpToolInfo[];
  stderr: string[];
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  nextId: number;
  buffer: string;
}

interface G {
  __mydeskMcp?: {
    runtimes: Map<string, Runtime>;
    configs: Map<string, McpServerConfig>;
  };
}

const g = globalThis as unknown as G;
if (!g.__mydeskMcp) {
  g.__mydeskMcp = { runtimes: new Map(), configs: new Map() };
}
const { runtimes, configs } = g.__mydeskMcp;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const json = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      for (const s of json.servers ?? []) configs.set(s.id, s);
    }
  } catch { /* ignore */ }
}

function saveConfig() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ servers: [...configs.values()] }, null, 2));
  } catch { /* ignore */ }
}
loadConfig();

function request(rt: Runtime, method: string, params: unknown, ms = 15000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++rt.nextId;
    const timer = setTimeout(() => {
      rt.pending.delete(id);
      reject(new Error(`${method} 超时（${ms}ms）`));
    }, ms);
    rt.pending.set(id, { resolve, reject, timer });
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    rt.child.stdin.write(line);
  });
}

function feed(rt: Runtime, chunk: string) {
  rt.buffer += chunk;
  let idx: number;
  while ((idx = rt.buffer.indexOf("\n")) >= 0) {
    const line = rt.buffer.slice(0, idx).trim();
    rt.buffer = rt.buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && rt.pending.has(msg.id)) {
        const p = rt.pending.get(msg.id)!;
        rt.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    } catch { /* 非 JSON 行忽略 */ }
  }
}

export async function startServer(cfg: McpServerConfig): Promise<{ toolCount: number }> {
  if (!cfg.trusted) throw new Error("TRUST_REQUIRED：请先在设置中勾选信任该服务器");
  await stopServer(cfg.id, false);

  const child = spawn(cfg.command, cfg.args, {
    cwd: process.cwd(),
    env: { ...process.env, ...(cfg.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const rt: Runtime = {
    child, status: "starting", tools: [], stderr: [],
    pending: new Map(), nextId: 0, buffer: "",
  };
  runtimes.set(cfg.id, rt);
  configs.set(cfg.id, cfg);
  saveConfig();

  child.stdout.on("data", (d: Buffer) => feed(rt, d.toString()));
  child.stderr.on("data", (d: Buffer) => {
    rt.stderr.push(d.toString());
    if (rt.stderr.length > 200) rt.stderr.shift();
  });
  child.on("exit", (code) => {
    rt.status = "exited";
    rt.error = `进程退出（code ${code}）`;
    for (const [, p] of rt.pending) p.reject(new Error(rt.error));
    rt.pending.clear();
  });
  child.on("error", (err) => {
    rt.status = "failed";
    rt.error = err.message;
  });

  try {
    await request(rt, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mydesk-local", version: "1.0.0" },
    }, 20000);
    rt.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const res = (await request(rt, "tools/list", {}, 15000)) as {
      tools?: { name: string; description?: string }[];
    };
    rt.tools = (res.tools ?? []).map((t) => ({
      server: cfg.id, name: t.name, description: t.description ?? "",
    }));
    rt.status = "ready";
    return { toolCount: rt.tools.length };
  } catch (e) {
    rt.status = "failed";
    rt.error = (e as Error).message;
    try { child.kill(); } catch { /* ignore */ }
    throw e;
  }
}

export async function stopServer(id: string, save = true) {
  const rt = runtimes.get(id);
  if (rt) {
    try { rt.child.kill(); } catch { /* ignore */ }
    runtimes.delete(id);
  }
  if (save) saveConfig();
}

export async function callTool(server: string, tool: string, args: unknown) {
  const rt = runtimes.get(server);
  if (!rt || rt.status !== "ready") throw new Error(`服务器 ${server} 未就绪（先启动）`);
  return request(rt, "tools/call", { name: tool, arguments: args ?? {} }, 30000);
}

export function syncConfigs(servers: McpServerConfig[]) {
  for (const s of servers) {
    if (s && s.id && s.command) configs.set(s.id, s);
  }
  saveConfig();
}

export function listServers() {
  const ids = new Set([...configs.keys(), ...runtimes.keys()]);
  return [...ids].map((id) => {
    const rt = runtimes.get(id);
    return {
      id,
      config: configs.get(id) ?? null,
      status: rt?.status ?? "stopped",
      error: rt?.error,
      tools: rt?.tools ?? [],
      stderr: (rt?.stderr ?? []).slice(-5),
    };
  });
}

export function listAllTools(): McpToolInfo[] {
  const out: McpToolInfo[] = [];
  for (const [, rt] of runtimes) {
    if (rt.status === "ready") out.push(...rt.tools);
  }
  return out;
}
