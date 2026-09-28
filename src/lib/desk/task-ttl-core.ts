// P31 稳智对齐 P2 #14：任务过期时间（TTL 15 分钟，对齐稳智 ai_matrix_active_task_v1 的 15min 过期）纯核。
//
// 为什么单独成文件（2026-09-25）：
// - 这两个是纯函数（零 IO、不碰 store / 网络 / 别名），抽出来后单测可以 `node --test` 直跑；
// - 原先它们住在 use-chat.ts 里，而 use-chat 会连带拉起 store / quant-api，后者用了 `@/lib` 别名——
//   Node 没有 bundler 解析不了别名，导致 p31 整文件加载失败（用例一个都跑不了）；
// - 与项目其它 core 层同纪律：判定只有这一处，页面、use-chat、测试都吃同一份。
export const TASK_TTL_MS = 15 * 60 * 1000;

/**
 * 判定 runRef 是否过期（createdAt 超过 TASK_TTL_MS）。
 * createdAt 缺失（老存档）时按"未过期"处理（向后兼容）。
 */
export function isRunRefExpired(ref: { createdAt?: number } | undefined, now: number = Date.now()): boolean {
  if (ref?.createdAt == null) return false; // 老存档无 createdAt，不判过期
  return now - ref.createdAt > TASK_TTL_MS;
}
