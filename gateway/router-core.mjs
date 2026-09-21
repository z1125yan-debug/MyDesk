// P8 子轮 B 独立代理网关 —— 纯逻辑层（零依赖，node 内置模块都不需要，能被 node --test 直接 import）。
//
// 职责边界（用户口径 2026-09-21，本轮钉死）：
//  - 本网关做「分流」，个人量化工作台（3014）不做：enable_kairo_engine=true → 转发 3014，
//    完整启用 Agent / 契约 / 新鲜度；false 或未声明 → 直透对应 LLM 接口，**不访问 3014、不触发任何量化业务**。
//  - 分流只做请求字段判断，不做任何 LLM 推理。
//  - 同一会话（conversation_id）切换任何模型大脑，自动继承全部当前对话记忆。
//  - 不改动 3014 内核：本目录不 import 任何 src/ 模块，3014 对外契约（/api/ai/proxy 的
//    scene 门、x-ai-* 头、五类 SSE 帧）按现状消费。
//
// 记忆语义（单一规则，可测）：
//  客户端带全量历史 → 客户端为准，网关只旁路记账；
//  客户端只带本句（薄客户端，DSH 这类）→ 网关用会话存档补全历史再转发；
//  所以同一个 conversation_id 在 true/false 两条分支、任意大脑之间切换，对面看到的都是同一条时间线。

/** 只认布尔 true：false/缺省都走透传；"true"/1 这种不猜（用户口径写明是布尔参数） */
export function readEngineFlag(body) {
  const v = body?.enable_kairo_engine;
  if (v === true) return { enabled: true, reason: "enable_kairo_engine=true" };
  if (v === false) return { enabled: false, reason: "enable_kairo_engine=false（直透 LLM，不访问工作台）" };
  if (v === undefined || v === null) return { enabled: false, reason: "未声明 enable_kairo_engine：按透传处理（不访问工作台）" };
  return { enabled: false, reason: `enable_kairo_engine 不是布尔（收到 ${JSON.stringify(v)}）：不猜，按透传处理` };
}

/** 兼容 Base URL 填不填 /v1 的两种写法（与 3014 内核同一口径，各留一份、互不 import） */
export function apiBase(base) {
  return String(base ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * 大脑选择：body.kairo_backend 指定名字，缺省用 default_backend。
 * 认不出来的名字如实报错——静默回落默认大脑会把一句「问 DeepSeek」答成豆包的。
 */
export function resolveBackend(body, config) {
  const name = typeof body?.kairo_backend === "string" && body.kairo_backend.trim()
    ? body.kairo_backend.trim().toLowerCase()
    : (config?.default_backend ?? null);
  if (!name) return { ok: false, error: "未指定 kairo_backend 且网关没有 default_backend：可用大脑见 /healthz" };
  const entry = config?.backends?.[name];
  if (!entry) {
    const known = Object.keys(config?.backends ?? {}).join("、") || "（空）";
    return { ok: false, error: `不认识的大脑 "${name}"：已配置的是 ${known}` };
  }
  return { ok: true, name, backend: { ...entry } };
}

// ---------- 会话记忆 ----------

/** 只留角色/正文都是字符串的件（外部输入按不可信处理，形状不对的件不进转发也不进存档） */
export function sanitizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.role === "string" && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * 记忆合并（纯函数，网关唯一的一份判定）：
 *  - 薄客户端（本轮非 system 件只有 1 条 user）且存档有历史 → 存档补全（authoritative=server）；
 *  - 其余情况客户端自带历史 → 原样为准（authoritative=client），存档随后被这轮结果刷新。
 */
export function mergeMessages(stored, incoming) {
  const clean = sanitizeMessages(incoming);
  const nonSystem = clean.filter((m) => m.role !== "system");
  const history = sanitizeMessages(stored).filter((m) => m.role !== "system");
  const systems = clean.filter((m) => m.role === "system");
  if (nonSystem.length <= 1 && history.length) {
    const lastUser = nonSystem.length ? [nonSystem[nonSystem.length - 1]] : [];
    return { effective: [...systems, ...history, ...lastUser], authoritative: "server" };
  }
  return { effective: clean, authoritative: "client" };
}

/** 轮末记账：本轮实际发出去的对话（去掉 system）+ 回答，成为下一轮的存档 */
export function nextTranscript(effective, assistantText) {
  const t = sanitizeMessages(effective).filter((m) => m.role !== "system");
  return typeof assistantText === "string" && assistantText.trim() ? [...t, { role: "assistant", content: assistantText }] : t;
}

/** 内存会话表（可选落盘回调由服务层注入；本层不碰文件系统） */
export function createTranscriptStore({ maxConversations = 200 } = {}) {
  const map = new Map();
  return {
    get(conv) {
      if (typeof conv !== "string" || !conv) return [];
      return map.get(conv)?.messages ?? [];
    },
    set(conv, messages, meta = {}) {
      if (typeof conv !== "string" || !conv) return;
      map.set(conv, { messages, ...meta });
      // 粗粒度上限：超了先丢最旧的（本机代理工具不做配额系统，边界如实记录）
      while (map.size > maxConversations) {
        const oldest = map.keys().next().value;
        if (oldest === conv) break;
        map.delete(oldest);
      }
    },
    size: () => map.size,
  };
}

// ---------- 转发载荷 ----------

/** 剥掉网关自己的路由字段，其余原样透传给 LLM（OpenAI 端点对未知字段的容忍不赌） */
export function stripRouterFields(body) {
  const { enable_kairo_engine, kairo_backend, conversation_id, ...rest } = body ?? {};
  return rest;
}

/** true 分支：3014 /api/ai/proxy 的对话轮契约 = messages + stream + scene(必带，门闩) + watchlist */
export function buildWorkbenchPayload(body, effectiveMessages) {
  const scene = body?.scene && typeof body.scene === "object" ? body.scene : {};
  return {
    messages: effectiveMessages,
    stream: body?.stream === true,
    scene: {
      focusSymbol: scene.focusSymbol ?? body?.focus_symbol ?? null,
      ...(scene.sessionSymbol ?? body?.session_symbol ? { sessionSymbol: scene.sessionSymbol ?? body.session_symbol } : {}),
      ...(scene.prevScene ?? body?.prev_scene ? { prevScene: scene.prevScene ?? body.prev_scene } : {}),
    },
    ...(Array.isArray(body?.watchlist) ? { watchlist: body.watchlist } : {}),
  };
}

/**
 * true 分支的大脑凭据 → 3014 的 x-ai-* 头（内核既有契约，不改动它）。
 * gateway:true 的大脑（豆包本地网关这类不支持 tools 的）不发头——让 3014 走自己的 .env 通道，
 * 那条路带网关消息折叠（doubao2API 只收最后一条 user），换大脑的记忆继承才成立。
 */
export function workbenchHeaders(body, resolved) {
  if (!resolved?.ok) return {};
  const b = resolved.backend;
  if (b.gateway || !b.base_url) return {};
  return {
    "x-ai-provider": "openai",
    "x-ai-base-url": b.base_url,
    ...(b.api_key ? { "x-ai-api-key": b.api_key } : {}),
    "x-ai-model": String(body?.model ?? b.model ?? ""),
  };
}

// ---------- 3014 五类帧 → OpenAI 帧 ----------

export function makeChunkCtx(model) {
  return { id: `chatcmpl-kairo-${Date.now().toString(36)}`, model: model ?? "kairo-router", created: Math.floor(Date.now() / 1000), text: "", warnings: [], steps: [], intent: null, errored: null, finished: false };
}

/** 3014 SSE 帧扫描器：帧以空行分隔，只认 `data: {...}` 行（与内核 encodeStreamEvent 的形状对齐） */
export function createKairoFrameScanner() {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      const frames = [];
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        frames.push(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
      return frames;
    },
    flush() {
      const rest = buf.trim();
      buf = "";
      return rest ? [rest] : [];
    },
  };
}

function chunkLine(o) {
  return `data: ${JSON.stringify(o)}\n\n`;
}

/**
 * 一帧 3014 事件 → 要写给上层的 SSE 片段数组。
 * warning/step 不冒充正文：以 SSE 注释行透出（OpenAI 客户端按规范忽略注释行，原始流里仍可见、不撒谎）。
 */
export function kairoEventToSse(ev, ctx) {
  if (!ev || typeof ev !== "object") return [];
  const out = [];
  if (ev.type === "delta" && typeof ev.data?.content === "string") {
    ctx.text += ev.data.content;
    out.push(chunkLine({ id: ctx.id, object: "chat.completion.chunk", created: ctx.created, model: ctx.model, choices: [{ index: 0, delta: { content: ev.data.content }, finish_reason: null }] }));
  } else if (ev.type === "warning" && typeof ev.data?.text === "string") {
    ctx.warnings.push(ev.data.text);
    out.push(`: kairo-warning ${ev.data.text.replace(/\n/g, " ")}\n\n`);
  } else if (ev.type === "step") {
    ctx.steps.push(ev.data);
    out.push(`: kairo-step ${(ev.data?.label ?? ev.data?.tool ?? "step")} · ${ev.data?.status ?? ""}\n\n`);
  } else if (ev.type === "done") {
    if (typeof ev.data?.fullText === "string" && !ctx.text) ctx.text = ev.data.fullText;
    if (ev.data?.intent) ctx.intent = ev.data.intent;
    if (!ctx.finished) {
      ctx.finished = true;
      out.push(chunkLine({ id: ctx.id, object: "chat.completion.chunk", created: ctx.created, model: ctx.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      out.push("data: [DONE]\n\n");
    }
  } else if (ev.type === "error" && typeof ev.data?.message === "string") {
    ctx.errored = ev.data.message;
    if (!ctx.finished) {
      ctx.finished = true;
      out.push(`: kairo-error ${ctx.errored.replace(/\n/g, " ")}\n\n`);
      out.push("data: [DONE]\n\n");
    }
  }
  return out;
}

/** 解码一帧 `data: {...}`；坏帧返回 null（调用方原样忽略，不让半截帧污染流） */
export function decodeKairoFrame(frame) {
  const line = String(frame ?? "").split("\n").find((l) => l.startsWith("data:"));
  if (!line) return null;
  try {
    const o = JSON.parse(line.slice(5).trim());
    return o && typeof o.type === "string" ? o : null;
  } catch {
    return null;
  }
}

/** 非流式：3014 的 JSON（content/intent/steps/warning）包成 OpenAI chat.completion，量化附加信息放 kairo 字段（客户端可无视） */
export function wrapWorkbenchJson(workbenchJson, model) {
  const content = String(workbenchJson?.content ?? "");
  return {
    id: `chatcmpl-kairo-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model ?? "kairo-router",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    kairo: {
      ...(workbenchJson?.intent ? { intent: workbenchJson.intent } : {}),
      ...(Array.isArray(workbenchJson?.steps) ? { steps: workbenchJson.steps } : {}),
      ...(workbenchJson?.warning ? { warning: workbenchJson.warning } : {}),
      ...(workbenchJson?.trace ? { trace: workbenchJson.trace } : {}),
    },
  };
}

/** OpenAI 风格错误体（两条分支、两种传输统一用它，上层解析不用认第二套形状） */
export function openaiError(message, type = "kairo_router_error") {
  return { error: { message: String(message ?? "未知错误"), type } };
}
