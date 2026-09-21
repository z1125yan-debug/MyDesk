// P8-⑥ 断点续传的挂点：POST /api/ai/run { action: "stop" | "resume", run, since }
//
// 这个端点只做两件事，且都不产生新事实：
//  - stop：把带 run 的轮次标记为「用户显式停止」（幂等）。真正的收尾由原 producer 路由完成——
//    它在下一次 isCancelled 检查处退出、照旧发 error 帧并封卷，剩余预取项在 dispatch-core 里留 notRun 痕迹；
//  - resume：从留底里重放 since 之后的帧；轮次还活着就挂上订阅接着推（重放与订阅同一次同步建立，中间不 await）。
//  服务端没这个 run（重启/超 TTL/从未挂底）→ 404 + 如实的 error 文案，客户端据此收口草稿、**不自动重问**。
//
// 五类帧契约原样复用（step/delta/warning/done/error + 顶层 seq），续传流与首轮流对客户端同形。
import { NextRequest, NextResponse } from "next/server";
import { RUNS } from "@/lib/desk/run-bus";
import { encodeStreamEvent } from "@/lib/desk/chat-stream-core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { action?: unknown; run?: unknown; since?: unknown } | null;
  const run = typeof body?.run === "string" && body.run ? body.run : "";
  if (!run) return NextResponse.json({ error: "缺少 run（非空字符串）" }, { status: 400 });
  const action = body?.action;

  if (action === "stop") {
    RUNS.sweep();
    const r = RUNS.cancel(run);
    // 已回收的 run 停止请求不算错误重演：ok:false + 原因，客户端无需二次动作
    return NextResponse.json({ ok: r.ok, ...(r.error ? { note: r.error } : {}) });
  }
  if (action !== "resume") {
    return NextResponse.json({ error: `未知 action：${JSON.stringify(action) ?? String(action)}（本端点只认 stop/resume）` }, { status: 400 });
  }

  RUNS.sweep();
  const since = typeof body?.since === "number" && Number.isFinite(body.since) && body.since >= 0 ? Math.trunc(body.since) : 0;
  const replay = RUNS.replay(run, since);
  if (!replay) {
    return NextResponse.json({ error: "本轮已无留底（服务重启或超出 5 分钟保留窗口）：不可续传，保留断点前内容即可" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  const close = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    unsubscribe?.();
    unsubscribe = null;
    try {
      controller.close();
    } catch { /* 已关闭 */ }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (line: string) => {
        try {
          controller.enqueue(encoder.encode(line));
        } catch { /* 连接已断：cancel() 负责摘订阅 */ }
      };
      // 缺头如实带 warning（细则 §2.4）：这条只写给本连接，不进留底——留底里少的那几帧才是事实
      if (replay.gap) {
        write(encodeStreamEvent({ type: "warning", data: { text: "断点前部分事件已过期未留底（留底有上限），本轮正文以收尾的 done 为准。" } }));
      }
      for (const f of replay.frames) write(encodeStreamEvent(f.event, f.seq));
      if (replay.sealed) {
        close(controller); // done/error 已在重放里，收流
        return;
      }
      unsubscribe = RUNS.subscribe(run, (line) => {
        if (line === null) {
          close(controller); // 封卷信号：producer 收尾了
          return;
        }
        write(line);
      });
      // 订阅内部已处理「挂上时已封卷」：立刻回 null，不会挂死
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      // 缺头事实带给客户端（resumeChat 读它填 gap 字段）；warning 帧已发，这里只是不靠字符串匹配
      ...(replay.gap ? { "x-kairo-resume-gap": "1" } : {}),
    },
  });
}
