// P54 输出退化（重复死循环）判定：上游模型卡在同一条短句上反复输出时的确定性截断
//
// 事故（2026-09-27 真机抓包 `q2.txt`）：本机 dev server 发问「上证指数现在多少点？」，
// 上游（AMD 网关 DeepSeek-V4-Flash-Vision-Exp）在回显完注入的数据块之后，卡在一句
// 「请用自然语言散文体输出，不要用列表。」上**连续重复约 440 次**（2848 帧 / 4860 字），
// 既没有结论也没有 [DONE]，一直吐到单轮 60s 超时被打断 ——
// 用户看到的是：一屏重复废话 + 一句「AI 服务异常」。
//
// 这是模型侧的采样退化（不是提示词能约束住的东西），所以按与 answer-guard-core 一样的纪律处理：
// 在**输出边界**上做确定性判定 + 截断，绝不把重复尾巴放给用户，也绝不为此白等一个超时。
//
// 判据（只认两种，都要求「同一行」而不是「同一句」—— 中文正文里换行才是段落边界）：
//   A. 尾部连续重复：忽略空行后，最后一行在尾部连续出现 ≥ minRepeats 次；
//   B. 全篇高频重复：某一行出现 ≥ maxTotal 次；或出现 ≥ 4 次且这些行已占全文 ≥ 25%
//      （后者是实测加的：分组重复时单行在尾部并不连续，等满 12 次才判会先漏出去半屏）。
//
// 纪律：
//   - **只删重复、不删内容**：kept 保留被重复那一行的**第一份**，只砍掉后面的重复尾巴；
//   - 阈值从严：短行（< minLineLen）不参与判定，正常答案里「---」「·」这类重复不会被抓；
//   - 零 IO 纯函数：不 import、不读 env、不碰时钟，node 直跑可测。

export interface DegenVerdict {
  /** 判为退化 */
  degenerate: boolean;
  /** 建议保留的正文：重复尾巴之前的原文（保留第一份），未判退化时等于入参原文 */
  kept: string;
  /** 被重复的那一行（留痕用） */
  repeated: string;
  /** 观测到的重复次数 */
  count: number;
}

const NOT_DEGENERATE = (text: string): DegenVerdict => ({ degenerate: false, kept: text, repeated: "", count: 0 });

/** 保留到「第一次出现这一行」为止（含这一份），后面的重复一律砍掉 */
function keepThroughFirst(lines: string[], firstIdx: number): string {
  return lines.slice(0, firstIdx + 1).join("\n").replace(/\s+$/, "");
}

/**
 * 检测文本里是否出现重复死循环。
 *
 * @param text        待判文本（流式下传「已收到的全文」）
 * @param minRepeats  尾部连续重复多少行才算退化（默认 4）
 * @param minLineLen  参与判定的行最短长度（默认 6，滤掉分隔符/单字）
 * @param maxTotal    全篇出现多少次才算高频重复（默认 12）
 */
export function detectRepetition(
  text: string,
  opts?: { minRepeats?: number; minLineLen?: number; maxTotal?: number },
): DegenVerdict {
  if (!text) return NOT_DEGENERATE(text);
  const minRepeats = Math.max(3, Math.trunc(opts?.minRepeats ?? 4));
  const minLineLen = Math.max(2, Math.trunc(opts?.minLineLen ?? 6));
  const maxTotal = Math.max(minRepeats * 2, Math.trunc(opts?.maxTotal ?? 12));

  const lines = text.split("\n");

  // A. 尾部连续重复（允许中间夹空行）
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) { lastIdx = i; break; }
  if (lastIdx >= 0) {
    const key = lines[lastIdx].trim();
    if (key.length >= minLineLen) {
      let run = 0;
      let start = lastIdx;
      for (let i = lastIdx; i >= 0; i--) {
        const t = lines[i].trim();
        if (!t) continue;               // 空行不打断「连续」
        if (t !== key) break;
        run++;
        start = i;
      }
      if (run >= minRepeats) {
        return { degenerate: true, kept: keepThroughFirst(lines, start), repeated: key, count: run };
      }
    }
  }

  // B. 全篇高频重复（不要求连续）：出现次数够多，或者次数虽少但已经占了相当篇幅
  const seen = new Map<string, { n: number; first: number }>();
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.length < minLineLen) continue;
    const cur = seen.get(t) ?? { n: 0, first: i };
    cur.n++;
    seen.set(t, cur);
  }
  for (const [line, info] of seen) {
    const share = line.length * info.n;
    const heavy = info.n >= minRepeats && share >= text.length * 0.25;   // 分组重复：次数少但占比高
    if (info.n < maxTotal && !heavy) continue;
    return { degenerate: true, kept: keepThroughFirst(lines, info.first), repeated: line, count: info.n };
  }

  return NOT_DEGENERATE(text);
}

/** 退化截断的用户可见留痕（调用方发一条 warning，不静默丢内容） */
export function degenWarning(v: DegenVerdict): string {
  const sample = v.repeated.length > 24 ? `${v.repeated.slice(0, 24)}…` : v.repeated;
  return `模型这一轮陷进了重复输出（「${sample}」连续重复 ${v.count} 次），已在此处截断并保留前面的正文。`;
}
