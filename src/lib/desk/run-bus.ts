// P8-⑥ 运行留底的服务层：进程内 Map<runId, Run>。
// 纯核（run-bus-core）管「帧与序号」，这一层只管三件运营的事：谁在订阅、谁被停止、什么时候回收。
//
// 边界（如实写死）：
//  - 单进程内存态——服务重启即全丢，不做落盘（把行情答案残片写进存档目录是另一种脏）；
//    丢了之后续传拿到 404，客户端按细则 §2.3 出 warning + 就地收口，不自动重问；
//  - 上限 20 个 run：先逐「封卷最久」的，全是活口就如实拒绝新建——新轮次照旧无 run 跑完，
//    绝不谎称可续传；
//  - 完成的 run 留 5 分钟（刷新 + 重挂的时间窗）；未封卷的永不按时回收，由路由 maxDuration 天花板兜底。
//
// dev 热重载会重建本模块 = Map 清零，等价于「服务重启」这条边界，走同一条 404 收口路径。
import { createRunBuffer, sweepFinished, type RunBuffer, type RunFrame } from "./run-bus-core.ts";
import { encodeStreamEvent } from "./chat-stream-core.ts";
import type { StreamEvent } from "./chat-stream-core.ts";

export const RUN_BUS_MAX_RUNS = 20;
export const RUN_BUS_FINISHED_TTL_MS = 5 * 60_000;

export interface Run {
  id: string;
  buffer: RunBuffer;
  createdAt: number;
  finishedAt: number | null;
  cancelled: boolean;
  /** 订阅者收到的是已带 seq 的编码帧行；null 表示封卷（收到即可收流） */
  subscribers: Set<(line: string | null) => void>;
}

export interface RunBus {
  /** 新建留底位。形状不对/撞号/满员都回 { ok:false }——调用方照常跑轮，只是这轮不可续传 */
  start(id: string): { ok: boolean; error?: string };
  /** 留一帧并通知活订阅者；run 不存在回 null（路由裸发，不谎称留了底） */
  publish(id: string, ev: StreamEvent): { seq: number | null; line: string } | null;
  /** 断点重放：run 不存在/已回收回 null（→ 404）；gap=true 表示缺头，必须如实带 warning */
  replay(id: string, since: number): { frames: RunFrame[]; gap: boolean; sealed: boolean } | null;
  /** 重放之后挂订阅（**必须与 replay 同一次同步执行**，中间不能 await，否则会漏掉两帧之间的实发） */
  subscribe(id: string, cb: (line: string | null) => void): () => void;
  seal(id: string): void;
  /** 幂等：重复停止不算错；run 已回收则如实报 */
  cancel(id: string): { ok: boolean; error?: string };
  cancelled(id: string): boolean;
  /** 回收到期封卷的 run（start 内部也会先跑一遍，不挂定时器） */
  sweep(): number;
  size(): number;
}

export function createRunBus(now: () => number = () => Date.now()): RunBus {
  const map = new Map<string, Run>();

  const sweep = () => {
    const doomed = sweepFinished(
      [...map.values()].map((r) => ({ id: r.id, sealed: r.buffer.sealed(), finishedAt: r.finishedAt })),
      now(),
      RUN_BUS_FINISHED_TTL_MS,
    );
    for (const id of doomed) map.delete(id);
    return doomed.length;
  };

  return {
    start(id) {
      if (typeof id !== "string" || !id) return { ok: false, error: "run id 必须是非空字符串" };
      sweep();
      if (map.has(id)) return { ok: false, error: `run ${id} 已有留底：不静默重建，本轮按无 run 正常跑` };
      if (map.size >= RUN_BUS_MAX_RUNS) {
        // LRU：让位的是「封卷最早」的；一个封卷的都没有就拒绝新建——正在跑的轮次谁也不挤谁
        const sealedRuns = [...map.values()].filter((r) => r.buffer.sealed());
        if (!sealedRuns.length) return { ok: false, error: `留底位已满（${RUN_BUS_MAX_RUNS}）且都在执行：本轮按无 run 正常跑，如实不可续传` };
        sealedRuns.sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
        map.delete(sealedRuns[0].id);
      }
      map.set(id, { id, buffer: createRunBuffer(), createdAt: now(), finishedAt: null, cancelled: false, subscribers: new Set() });
      return { ok: true };
    },
    publish(id, ev) {
      const run = map.get(id);
      if (!run) return null;
      const seq = run.buffer.publish(ev);
      const line = encodeStreamEvent(ev, seq ?? undefined);
      if (seq != null) {
        for (const cb of [...run.subscribers]) cb(line);
      }
      return { seq, line };
    },
    replay(id, since) {
      const run = map.get(id);
      if (!run) return null;
      const r = run.buffer.replaySince(since);
      return { ...r, sealed: run.buffer.sealed() };
    },
    subscribe(id, cb) {
      const run = map.get(id);
      if (!run) return () => {};
      // 已经封卷的 run 不会再有 publish：立刻给收尾信号，不能让订阅者挂死等一个永远不来的 done
      if (run.buffer.sealed()) {
        cb(null);
        return () => {};
      }
      run.subscribers.add(cb);
      return () => {
        run.subscribers.delete(cb);
      };
    },
    seal(id) {
      const run = map.get(id);
      if (!run || run.buffer.sealed()) return;
      run.buffer.seal();
      run.finishedAt = now();
      // 通知与摘除一步到位：订阅者收到 null 就收尾关流，不留挂着的 cb 等回收
      const cbs = [...run.subscribers];
      run.subscribers.clear();
      for (const cb of cbs) cb(null);
    },
    cancel(id) {
      const run = map.get(id);
      if (!run) return { ok: false, error: "该轮没有留底（已被回收或从未挂底）" };
      run.cancelled = true; // 幂等：重复 cancel 只多设一次 true
      return { ok: true };
    },
    cancelled: (id) => map.get(id)?.cancelled === true,
    sweep,
    size: () => map.size,
  };
}

/** 进程内单例：路由 import 这个；测试用 createRunBus 自造带注入时钟的实例 */
export const RUNS = createRunBus();
