// 东财 clist 响应纯解析核：data.diff 两种形状都认。
// 行数组（push2 主站）或「下标→行」字典（push2delay 镜像 2026-10-20 实测出现过）。
// 字典按数字下标升序还原成行数组；其余形状（缺失/字符串/数字）一律 null = 不可用，
// 绝不把坏形状当成空榜。这正是 2026-10-20 下午分支榜降级的根因：取数层按 HTTP 层
// 判成功，调用方按数组迭代当场抛错——板块榜误落异源兜底、全榜单页静默丢行。
export function clistDiffRows(j: unknown): Record<string, unknown>[] | null {
  const diff = (j as { data?: { diff?: unknown } } | null)?.data?.diff;
  if (Array.isArray(diff)) return diff as Record<string, unknown>[];
  if (diff && typeof diff === "object") {
    return Object.entries(diff as Record<string, unknown>)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, v]) => v) as Record<string, unknown>[];
  }
  return null;
}
