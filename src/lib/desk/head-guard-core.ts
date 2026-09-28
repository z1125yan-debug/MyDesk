// P55 输出边界护栏（流式侧）——与 /api/ai/chat 的 createHeadGuard 同一条判定链的共享版。
//
// 为什么抽出来：/api/ai/proxy（浏览器凭据 / 网关文本协议那条路）此前**一条护栏都没接**，
// 实测（2026-09-27 截图）上游把注入的快讯行 + 周期口径 + 行情快照整段抄回正文、原样流给了用户。
// chat/route.ts 里的那份被 p52/p53/p54 的源码钉原文钉住，不动它；这里给 proxy（以及后续入口）用。
// 两份逻辑必须保持同口径：改判定先改 answer-guard-core / degen-core（纯核），这份只是接线。
//
// 口径：
//   - 头部缓冲判定（RAW_FLUSH_MIN/CAP + 行边界闸）逐字同 chat route；
//   - delta 逐帧过 detectRepetition，命中即停发 + warning（degen）；
//   - done.fullText 以本层累计为准（上游截断/剥头后的正文），再各判一次重复；
//   - 暴露 isDegenerate() 给上游流循环：命中退化时把上游 body 掐掉，不再白烧到超时。

import type { StreamEvent } from "./chat-stream-core";
import { stripScaffoldEcho, SCAFFOLD_ONLY_NOTICE, type GuardOpts } from "./answer-guard-core";
import { detectRepetition, degenWarning, type DegenVerdict } from "./degen-core";

export function createHeadGuard(emit: (ev: StreamEvent) => void, opts?: GuardOpts) {
  // 攒到 120 字就能判一次；到 2000 字还没判出来就强制判（防止上游只吐脚手架时不发 delta）
  const RAW_FLUSH_MIN = 120;
  const RAW_FLUSH_CAP = 2000;

  let raw = "";
  let decided = false;
  let emitted = "";
  /** P54：一旦判到重复死循环，后面的循环尾巴一律不再转发（已经在网络上的那几行收不回来） */
  let degen: DegenVerdict | null = null;
  /** P55-C：「整篇都是脚手架」的兜底话术先押着不发——中途 step 事件强制判定时，后面轮次可能还有真正文（q17 实测拼接事故） */
  let pendingNotice = false;

  const decide = (final: boolean) => {
    if (decided) return;
    const g = stripScaffoldEcho(raw, opts);
    if (!final && (g.text.length < RAW_FLUSH_MIN || (!raw.endsWith("\n") && raw.length < RAW_FLUSH_CAP))) return;
    decided = true;
    raw = "";
    if (g.stripped) emit({ type: "warning", data: { text: "已过滤模型复述的内部信号字段、自述与思维链，正文从结论开始。" } });
    // 整篇都是脚手架（模型把 system prompt 回吐）：不给用户看内部提示词，换成一句如实的话
    emitted = g.text || (g.stripped ? SCAFFOLD_ONLY_NOTICE : "");
    // 头部本身也可能是重复死循环的开头（实测「回显数据块 + 一句要求」之后才开始重复）
    const v = detectRepetition(emitted);
    if (v.degenerate) {
      degen = v;
      // P55：kept 是「重复行的第一份」，它自己也可能整段是回显/脚手架（q10 实测：重复的是
      // 「用户持仓周期：…」字段自报块）——再剥一次头，剥空了换兜底话术。
      const kg = stripScaffoldEcho(v.kept || "", opts);
      emitted = kg.text || (kg.stripped ? SCAFFOLD_ONLY_NOTICE : (v.kept || SCAFFOLD_ONLY_NOTICE));
      emit({ type: "warning", data: { text: degenWarning(v) } });
    }
    // P55-C：兜底话术押后——首个真正文 delta 来了就取消；done 还押着才发（q17：提前发会被拼在真正文前面）
    if (emitted === SCAFFOLD_ONLY_NOTICE) { pendingNotice = true; emitted = ""; }
    if (emitted) emit({ type: "delta", data: { content: emitted } });
  };

  return {
    emit(ev: StreamEvent) {
      if (ev.type === "delta") {
        const piece = String((ev.data as { content?: string } | undefined)?.content ?? "");
        if (degen) return;   // 已判退化：循环尾巴一律不发
        if (decided) {
          // P55-C：真正文来了，押着的兜底话术作废
          if (pendingNotice) { pendingNotice = false; emitted = ""; }
          const next = emitted + piece;
          const v = detectRepetition(next);
          if (v.degenerate) {
            degen = v;
            emit({ type: "warning", data: { text: degenWarning(v) } });
            // 保留循环之前的正文；已发出去的那几行收不回来，但收尾留底以 kept 为准
            if (v.kept) emitted = v.kept;
            return;
          }
          emitted = next;
          emit(ev);
          return;
        }
        raw += piece;
        if (raw.length >= RAW_FLUSH_CAP || /\n\s*\n/.test(raw) || raw.length >= RAW_FLUSH_MIN) decide(false);
        return;
      }
      if (ev.type === "done") {
        decide(true);
        // P55-C：到收尾还押着兜底话术（整轮只有脚手架、没有正文）→ 此刻才发
        if (pendingNotice) { pendingNotice = false; emitted = SCAFFOLD_ONLY_NOTICE; emit({ type: "delta", data: { content: emitted } }); }
        // done 的 data 形状在本层只关心 fullText；联合类型上直接展开会丢判别，这里显式收窄
        const done = ev as { type: "done"; data?: Record<string, unknown> };
        const d = { ...(done.data ?? {}) };
        if (typeof d.fullText === "string") {
          // P54：上游那侧已经掐断过一次（route 返回的 fullText 就是截断后的），这里以本层累计为准；
          // 本层没累计到东西时回落到「对上游 fullText 再判一次重复」，最后才是剥头结果。
          const fallback = stripScaffoldEcho(String(d.fullText), opts).text;
          const fv = detectRepetition(fallback);
          const ev2 = detectRepetition(emitted);
          // 本层累计的正文优先；但它自己也可能带重复尾巴（上游那侧掐断前已经流出去的几行），再过一次。
          // P55：退化时 kept 的第一份也可能是回显/脚手架块（q10 实测），同样再剥一次头。
          let head = ev2.degenerate ? (ev2.kept || "") : emitted;
          if (ev2.degenerate && head) {
            const kg = stripScaffoldEcho(head, opts);
            head = kg.text || (kg.stripped ? "" : head);
          }
          const finalRaw = head || (fv.degenerate ? fv.kept : fallback);
          // P55：终检一遍（中段整段清理）——已流出的帧收不回来，但留底/刷新续传是干净的
          const fg = stripScaffoldEcho(finalRaw, opts);
          d.fullText = fg.text || (fg.stripped ? SCAFFOLD_ONLY_NOTICE : finalRaw);
        }
        emit({ ...done, data: d } as unknown as StreamEvent);
        return;
      }
      // 其它事件（step/stage/warning/error）：先把没发完的头按序发出去，别让时间线插到正文前面
      if (!decided && raw) decide(true);
      emit(ev);
    },
    /** 收尾兜底：run 结束仍没决定过就补一次（此时按「整篇都是脚手架」处理） */
    flush() { decide(true); },
    /** P55：上游流循环轮询它——判到退化就把上游 body 掐掉，不再白烧到超时 */
    isDegenerate(): boolean { return degen !== null; },
  };
}
