"use client";
import { useEffect, useState } from "react";
import { Loader2, PlugZap, Server, Plus, Trash2, FileJson, Info } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { LifecyclePanel } from "../LifecyclePanel";
import { CapabilityPanel } from "../CapabilityPanel";
import { aiChat, aiConfigured, PROVIDER_PRESETS } from "@/lib/desk/ai";
import { useServerLlm } from "@/lib/desk/use-server-llm";
import type { AiProvider, McpServerConfig, McpToolInfo } from "@/lib/desk/types";

export default function SettingsPage() {
  const ai = useDesk((s) => s.ai);
  const setAi = useDesk((s) => s.setAi);
  const mcpServers = useDesk((s) => s.mcpServers);
  const setMcpServers = useDesk((s) => s.setMcpServers);
  const refreshInterval = useDesk((s) => s.refreshInterval);
  const setRefreshInterval = useDesk((s) => s.setRefreshInterval);

  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // MCP 相关
  const [runtimes, setRuntimes] = useState<Record<string, { status: string; toolCount?: number; error?: string }>>({});
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [mcpBusy, setMcpBusy] = useState("");
  const [newSrv, setNewSrv] = useState({ name: "", command: "", args: "", env: "" });
  const [jsonText, setJsonText] = useState("");
  const [jsonMsg, setJsonMsg] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        // 挂载时先把本地配置同步到服务端（幂等），之后只读状态
        await fetch("/api/mcp/servers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ servers: useDesk.getState().mcpServers }),
        });
        const r = await fetch("/api/mcp/servers");
        const j = await r.json();
        const map: typeof runtimes = {};
        for (const s of j.servers ?? []) map[s.id] = { status: s.status, toolCount: s.toolCount, error: s.error };
        setRuntimes(map);
      } catch { /* 服务未就绪 */ }
      try {
        const r = await fetch("/api/mcp/tools");
        const j = await r.json();
        setTools(j.tools ?? []);
      } catch { /* 忽略 */ }
    };
    load();
    const t = setInterval(async () => {
      try {
        const r = await fetch("/api/mcp/servers");
        const j = await r.json();
        const map: typeof runtimes = {};
        for (const s of j.servers ?? []) map[s.id] = { status: s.status, toolCount: s.toolCount, error: s.error };
        setRuntimes(map);
      } catch { /* 忽略 */ }
    }, 8000);
    return () => clearInterval(t);
  }, []);

  const sync = async (servers: McpServerConfig[]) => {
    setMcpServers(servers);
    await fetch("/api/mcp/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ servers }),
    }).catch(() => undefined);
  };

  const testConnection = async () => {
    setTesting(true); setTestMsg(null);
    try {
      const reply = await aiChat(ai, [{ role: "user", content: "回复两个字：成功" }], { timeoutMs: 30000 });
      setTestMsg({ ok: true, text: `连接成功：${reply.slice(0, 40) || "(空回复)"}` });
    } catch (e) {
      setTestMsg({ ok: false, text: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const mcpAction = async (id: string, action: "start" | "stop") => {
    setMcpBusy(id);
    try {
      await fetch("/api/mcp/servers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      const r = await fetch("/api/mcp/servers");
      const j = await r.json();
      const map: typeof runtimes = {};
      for (const s of j.servers ?? []) map[s.id] = { status: s.status, toolCount: s.toolCount, error: s.error };
      setRuntimes(map);
      const tr = await fetch("/api/mcp/tools");
      setTools((await tr.json()).tools ?? []);
    } finally {
      setMcpBusy("");
    }
  };

  const addServer = () => {
    if (!newSrv.name.trim() || !newSrv.command.trim()) return;
    const srv: McpServerConfig = {
      id: newSrv.name.trim().toLowerCase().replace(/\s+/g, "-") + "-" + Math.random().toString(36).slice(2, 6),
      name: newSrv.name.trim(),
      command: newSrv.command.trim(),
      args: newSrv.args.split(/\s+/).filter(Boolean),
      env: newSrv.env.trim() ? JSON.parse(newSrv.env) : undefined,
      trusted: false,
    };
    sync([...mcpServers, srv]);
    setNewSrv({ name: "", command: "", args: "", env: "" });
  };

  const importJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      const list = parsed.servers ?? parsed.mcpServers ?? parsed;
      let incoming: McpServerConfig[] = [];
      if (Array.isArray(list)) {
        incoming = list.map((s: Record<string, unknown>, i: number) => ({
          id: String(s.id ?? s.name ?? `srv-${i}`),
          name: String(s.name ?? s.id ?? `srv-${i}`),
          command: String(s.command ?? ""),
          args: Array.isArray(s.args) ? s.args.map(String) : [],
          env: (s.env && typeof s.env === "object") ? s.env as Record<string, string> : undefined,
          trusted: false,
        }));
      } else if (typeof list === "object") {
        incoming = Object.entries(list as Record<string, Record<string, unknown>>).map(([name, s]) => ({
          id: name.toLowerCase().replace(/\s+/g, "-"),
          name,
          command: String(s.command ?? ""),
          args: Array.isArray(s.args) ? s.args.map(String) : [],
          env: (s.env && typeof s.env === "object") ? s.env as Record<string, string> : undefined,
          trusted: false,
        }));
      }
      if (!incoming.length) throw new Error("没有识别到服务器配置");
      const merged = [...mcpServers.filter((m) => !incoming.some((n) => n.name === m.name)), ...incoming];
      sync(merged);
      setJsonMsg(`已导入 ${incoming.length} 个服务器（默认不信任，需手动开启）`);
      setJsonText("");
    } catch (e) {
      setJsonMsg(`导入失败：${(e as Error).message}`);
    }
  };

  const providerKeys = Object.keys(PROVIDER_PRESETS) as AiProvider[];
  const configured = aiConfigured(ai);
  const serverLlm = useServerLlm();

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-5">
      <div>
        <h1 className="text-xl font-bold">设置</h1>
        <p className="mt-1 text-[12.5px] text-muted-foreground">AI 接口、MCP 服务器与通用选项 —— 全部保存在本机</p>
      </div>

      {/* AI Provider */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold">
            <PlugZap size={15} className="text-sky-400" /> AI 接口
          </div>
          <span className={"rounded-full px-2.5 py-1 text-[11px] " + (configured ? "bg-emerald-500/12 text-emerald-300" : "bg-amber-500/12 text-amber-300")}>
            {configured ? "已配置" : "未配置"}
          </span>
        </div>
        <div className="border-b border-border px-4 py-2 text-[11.5px] text-muted-foreground">
          服务端 .env 模型通道：
          {serverLlm === null
            ? "探测中…（浏览器未配置凭据时自动走这条）"
            : serverLlm.available
              ? `可用 · ${serverLlm.mode === "gateway" ? "本地网关（免 Key）" : "官方 API"} · ${serverLlm.baseUrl} · ${serverLlm.model}（Key 只存在服务端 .env，不进浏览器）`
              : `不可用 —— ${serverLlm.reason ?? "未知原因"}`}
        </div>
        <div className="space-y-3.5 px-4 py-4">
          <div>
            <div className="mb-1.5 text-[12px] text-muted-foreground">服务商</div>
            <div className="flex flex-wrap gap-1.5">
              {providerKeys.map((p) => (
                <button key={p}
                  onClick={() => setAi({ provider: p, baseUrl: PROVIDER_PRESETS[p].baseUrl, model: PROVIDER_PRESETS[p].model })}
                  className={"rounded-md border px-3 py-1.5 text-[12px] transition-colors " +
                    (ai.provider === p ? "border-sky-500/50 bg-sky-500/12 text-sky-300" : "border-border text-muted-foreground hover:text-foreground")}>
                  {PROVIDER_PRESETS[p].label}
                </button>
              ))}
            </div>
            {PROVIDER_PRESETS[ai.provider]?.hint && (
              <div className="mt-1.5 text-[11.5px] text-muted-foreground">提示：{PROVIDER_PRESETS[ai.provider].hint}</div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="block">
              <span className="text-[12px] text-muted-foreground">Base URL（OpenAI 兼容地址，可用中转）</span>
              <input value={ai.baseUrl} onChange={(e) => setAi({ baseUrl: e.target.value })}
                placeholder="https://api.example.com"
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 font-mono text-[12px] outline-none focus:border-sky-500/60" />
            </label>
            <label className="block">
              <span className="text-[12px] text-muted-foreground">模型名</span>
              <input value={ai.model} onChange={(e) => setAi({ model: e.target.value })}
                placeholder="gpt-4o-mini"
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 font-mono text-[12px] outline-none focus:border-sky-500/60" />
            </label>
            <label className="block md:col-span-2">
              <span className="text-[12px] text-muted-foreground">API Key（只在本机浏览器保存，请求时经本地代理转发，不落库不进日志）</span>
              <input type="password" value={ai.apiKey} onChange={(e) => setAi({ apiKey: e.target.value })}
                placeholder={ai.provider === "ollama" ? "Ollama 无需填写" : "sk-…"}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 font-mono text-[12px] outline-none focus:border-sky-500/60" />
            </label>
            <label className="block md:col-span-2">
              <span className="text-[12px] text-muted-foreground">
                网络代理（境外接口被地域拦截时使用；留空=自动检测系统代理，direct=强制直连，或填 http://127.0.0.1:端口）
              </span>
              <input value={ai.proxy ?? ""} onChange={(e) => setAi({ proxy: e.target.value })}
                placeholder="自动（系统代理 / 启动脚本里的 HTTPS_PROXY）"
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2.5 font-mono text-[12px] outline-none focus:border-sky-500/60" />
            </label>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={testConnection} disabled={testing}
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-500/90 px-3.5 py-2 text-[12.5px] font-medium text-white hover:bg-sky-500 disabled:opacity-60">
              {testing && <Loader2 size={13} className="animate-spin" />} 测试连接
            </button>
            {testMsg && (
              <span className={"text-[12px] " + (testMsg.ok ? "text-emerald-400" : "text-rose-400")}>{testMsg.text}</span>
            )}
          </div>
        </div>
      </div>

      {/* MCP */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-[13.5px] font-semibold">
          <Server size={15} className="text-sky-400" /> MCP 服务器
          <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-normal text-muted-foreground">{mcpServers.length} 个</span>
        </div>
        <div className="space-y-3 px-4 py-4">
          {mcpServers.map((s) => {
            const rt = runtimes[s.id];
            return (
              <div key={s.id} className="rounded-lg border border-border bg-background/50 p-3">
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <span className="font-medium">{s.name}</span>
                  <code className="rounded bg-accent/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {s.command} {s.args.join(" ")}
                  </code>
                  <span className={"rounded px-1.5 py-0.5 text-[11px] " +
                    (rt?.status === "ready" ? "bg-emerald-500/12 text-emerald-300"
                      : rt?.status === "failed" ? "bg-rose-500/12 text-rose-300"
                      : rt?.status === "starting" ? "bg-amber-500/12 text-amber-300"
                      : "bg-accent text-muted-foreground")}>
                    {rt?.status ?? "未启动"}{rt?.toolCount != null ? ` · ${rt.toolCount} 工具` : ""}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                      <input type="checkbox" checked={s.trusted}
                        onChange={(e) => sync(mcpServers.map((m) => (m.id === s.id ? { ...m, trusted: e.target.checked } : m)))}
                        className="accent-sky-500" />
                      信任
                    </label>
                    <button onClick={() => mcpAction(s.id, rt?.status === "ready" ? "stop" : "start")} disabled={mcpBusy === s.id}
                      className="rounded-md border border-border px-2.5 py-1 text-[11.5px] text-muted-foreground hover:text-foreground disabled:opacity-50">
                      {rt?.status === "ready" ? "停止" : "启动"}
                    </button>
                    <button onClick={() => sync(mcpServers.filter((m) => m.id !== s.id))}
                      className="rounded p-1.5 text-muted-foreground hover:text-rose-400"><Trash2 size={13.5} /></button>
                  </div>
                </div>
                {rt?.error && <div className="mt-1.5 text-[11.5px] text-rose-400">{rt.error}</div>}
                {tools.filter((t) => t.server === s.id).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {tools.filter((t) => t.server === s.id).map((t) => (
                      <span key={t.name} title={t.description}
                        className="rounded bg-sky-500/10 px-2 py-0.5 font-mono text-[11px] text-sky-300">{t.name}</span>
                    ))}
                  </div>
                )}
                {!s.trusted && rt?.status === "ready" && (
                  <div className="mt-1.5 text-[11.5px] text-amber-300/80">未信任状态下工具调用会被拦截，需要调用请勾选「信任」。</div>
                )}
              </div>
            );
          })}

          <div className="rounded-lg border border-dashed border-border p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium"><Plus size={13} /> 手动添加</div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              <input value={newSrv.name} onChange={(e) => setNewSrv((p) => ({ ...p, name: e.target.value }))}
                placeholder="名称" className="h-8 rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-sky-500/60" />
              <input value={newSrv.command} onChange={(e) => setNewSrv((p) => ({ ...p, command: e.target.value }))}
                placeholder="命令，如 python" className="h-8 rounded-md border border-border bg-background px-2.5 font-mono text-[12px] outline-none focus:border-sky-500/60" />
              <input value={newSrv.args} onChange={(e) => setNewSrv((p) => ({ ...p, args: e.target.value }))}
                placeholder="参数（空格分隔）" className="h-8 rounded-md border border-border bg-background px-2.5 font-mono text-[12px] outline-none focus:border-sky-500/60" />
            </div>
            <button onClick={addServer}
              className="mt-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-[12px] text-sky-300 hover:bg-sky-500/20">
              添加服务器
            </button>
          </div>

          <div className="rounded-lg border border-dashed border-border p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium"><FileJson size={13} /> JSON 导入</div>
            <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} rows={3}
              placeholder={'{"mcpServers":{"demo-market":{"command":"python","args":["scripts/mcp/demo_market.py"]}}}'}
              className="w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] outline-none focus:border-sky-500/60" />
            <div className="mt-2 flex items-center gap-3">
              <button onClick={importJson}
                className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-[12px] text-sky-300 hover:bg-sky-500/20">导入</button>
              {jsonMsg && <span className="text-[11.5px] text-muted-foreground">{jsonMsg}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* 通用 */}
      <div className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-[13.5px] font-semibold">通用</div>
        <div className="px-4 py-4">
          <div className="text-[12px] text-muted-foreground">看板/行情自动刷新周期（本地实时数据的重新拉取间隔）</div>
          <div className="mt-2 flex gap-1.5">
            {[30, 60, 300, 900].map((n) => (
              <button key={n} onClick={() => setRefreshInterval(n)}
                className={"rounded-md border px-3 py-1.5 text-[12px] " +
                  (refreshInterval === n ? "border-sky-500/50 bg-sky-500/12 text-sky-300" : "border-border text-muted-foreground hover:text-foreground")}>
                {n < 60 ? `${n} 秒` : `${n / 60} 分`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <LifecyclePanel />

      <CapabilityPanel />

      <div className="flex items-start gap-2.5 rounded-xl border border-border bg-card p-4 text-[12.5px] leading-5 text-muted-foreground">
        <Info size={15} className="mt-0.5 shrink-0 text-sky-400" />
        <span>
          MyDesk 是运行在你电脑上的个人工具：A股行情与资金数据由本机直连公开接口获取，黄金/加密货币等品种为演示数据，AI 分析调用你自己配置的模型接口，
          自选/追踪/历史/会话保存在本机浏览器。所有输出仅供个人学习参考，不构成投资建议。
        </span>
      </div>
    </div>
  );
}
