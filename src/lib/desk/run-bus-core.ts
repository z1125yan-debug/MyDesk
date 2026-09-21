// P8-⑥ SSE 断点续传的纯内核：给「一轮回答」建一条按序号留底的帧缓冲——
// 页面刷新/代理掐线之后，客户端拿 lastSeq 来要「这之后的帧」，而不是把整轮分析重跑一遍。
//
// 分层纪律（和 skills-core / agent-loop-core 同一套）：
//  - 零 IO、零时钟：GC 用的 nowMs 由服务层注入（sweepFinished），本层不 new Date()，node --test 可直跑；
//  - 只认「帧 + 序号」，不认识 SSE/HTTP：怎么下发、谁订阅是 run-bus.ts（服务层）的活；
//  - 逐出如实置 gap：头被逐出就带缺头标记，绝不假装重放是完整的——续传的前提是可证完整。
import type { StreamEvent } from "./chat-stream-core.ts";

/** 单个 run 最多留底多少帧（一场分析的帧数上限估到几百，超了逐旧——续传只保「最近的断点」） */
export const RUN_MAX_EVENTS = 600;
/** 留底总字符上限（按序列化长度计；600 帧 × 1MB 双闸，防一条巨型 detail 把内存吃穿） */
export const RUN_MAX_CHARS = 1_000_000;

export interface RunFrame {
  seq: number;
  event: StreamEvent;
}

export interface ReplayResult {
  /** seq > since 的帧，按序号升序 */
  frames: RunFrame[];
  /** true = 要的起点之前有帧已被逐出（重放缺头，调用方必须如实带 warning，不假装完整） */
  gap: boolean;
}

/**
 * 一轮问答的帧留底缓冲。
 * publish 返回本帧序号（自增从 1）；封卷后拒收（返回 null）——done/error 之后再来事件是链路 bug，
 * 宁可不发序号让调用方裸发，也不给已定论的轮次追加「事后帧」。
 */
export function createRunBuffer(opts: { maxEvents?: number; maxChars?: number } = {}) {
  const maxEvents = Math.max(1, Math.trunc(opts.maxEvents ?? RUN_MAX_EVENTS) || RUN_MAX_EVENTS);
  const maxChars = Math.max(1, Math.trunc(opts.maxChars ?? RUN_MAX_CHARS) || RUN_MAX_CHARS);
  type Inner = { seq: number; event: StreamEvent; size: number };
  const frames: Inner[] = [];
  let seq = 0;
  let chars = 0;
  /** 已被逐出的最大序号（0 = 还没逐出过；gap 判据就是它） */
  let evictedTo = 0;
  let sealed = false;
  let finalSeq: number | null = null;

  return {
    publish(event: StreamEvent): number | null {
      if (sealed) return null;
      if (!event || typeof event !== "object" || typeof (event as StreamEvent).type !== "string") return null;
      seq += 1;
      let size = 2; // 序列化不了（循环引用之类极端情况）：留个极小占位，宁可少算也不谎称精确
      try {
        size = JSON.stringify(event).length;
      } catch {
        /* 保持占位 */
      }
      frames.push({ seq, event, size });
      chars += size;
      // 逐旧保新：断点续传要的是「最近的尾巴」。至少留 1 帧——单帧就超闸时如实破例，续传至少能接上最后一帧
      while (frames.length > maxEvents || (chars > maxChars && frames.length > 1)) {
        const old = frames.shift();
        if (!old) break;
        evictedTo = old.seq;
        chars -= old.size;
      }
      return seq;
    },

    /** 要「since 之后」的帧：since=0 表示从头全要；空缓冲不算 gap（没留过底 ≠ 底被逐出） */
    replaySince(since: number): ReplayResult {
      const from = Number.isFinite(since) && since > 0 ? Math.trunc(since) : 0;
      const out: RunFrame[] = frames
        .filter((f) => f.seq > from)
        .map((f) => ({ seq: f.seq, event: f.event }));
      return { frames: out, gap: evictedTo > from };
    },

    /** done/error 之后封卷：只读，不再收 publish。final 省略＝以最后一帧序号收口 */
    seal(final?: number) {
      if (sealed) return;
      sealed = true;
      finalSeq = typeof final === "number" && Number.isFinite(final) ? Math.trunc(final) : seq;
    },
    sealed: () => sealed,
    /** 当前留底帧数（逐出后会变小） */
    size: () => frames.length,
    lastSeq: () => seq,
    finalSeq: () => finalSeq,
    evictedTo: () => evictedTo,
    chars: () => chars,
  };
}

export type RunBuffer = ReturnType<typeof createRunBuffer>;

export interface SweepEntry {
  id: string;
  sealed: boolean;
  finishedAt: number | null;
}

/**
 * GC 计划（纯函数）：列出「封卷且到期」的 runId。
 * 只出计划不动手——Map 归服务层所有，删除动作也归它；时钟 nowMs 由调用方给，方便测试钉死时间。
 * 未完成（未封卷）的 run 永不回收：它有路由 maxDuration 的天花板兜底，终会封卷。
 */
export function sweepFinished(entries: SweepEntry[], nowMs: number, ttlMs: number): string[] {
  return (entries ?? [])
    .filter((e) => e && e.sealed && typeof e.finishedAt === "number" && nowMs - e.finishedAt >= ttlMs)
    .map((e) => e.id);
}
