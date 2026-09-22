// P14 收口轮：自选分组的纯操作核（零 IO，node --test 可直跑；store.ts 的三个 action 全部转调这里）。
//
// 为什么抽这一层：分组最容易写坏的不是建组，是**删组**——稳智口径下删组只是销组，
// 成员一律回「未分组」，一只票都不许跟着消失（丢票是把管理动作做成破坏动作）。
// 这条语义藏在 zustand action 里就没法在 node 下测（store 是客户端模块），所以拆成纯函数。
// 「未分组」不是这里的一条记录，是 groupId 为空的读法——旧存档没这个字段，天然按未分组读，无需迁移。

export interface WatchGroup { id: string; name: string }
export interface WatchLike { groupId?: string | null }

/**
 * 建组：空名/全空白拒绝（返回原表不动）；同名不重建、返回既有 id（页面不出现两个「短线」）；
 * 存库前 trim。id 由调用方注入（mkId），纯核不碰时钟。
 */
export function addGroupCore<W extends WatchLike>(
  groups: WatchGroup[], name: string, mkId: () => string,
): { groups: WatchGroup[]; id: string | null } {
  const n = name.trim();
  if (!n) return { groups, id: null };
  const dup = groups.find((g) => g.name === n);
  if (dup) return { groups, id: dup.id };
  const id = mkId();
  return { groups: [...groups, { id, name: n }], id };
}

/** 删组只销组：组从清单消失，成员全部回未分组——watchlist 条数一根毛都不能少 */
export function removeGroupCore<W extends WatchLike>(
  groups: WatchGroup[], watchlist: W[], id: string,
): { groups: WatchGroup[]; watchlist: W[] } {
  return {
    groups: groups.filter((g) => g.id !== id),
    watchlist: watchlist.map((w) => (w.groupId === id ? { ...w, groupId: null } : w)),
  };
}

/** 移组：只动目标那一身的成员关系（groupId=null 即移回未分组），其余原样 */
export function moveWatchCore<W extends WatchLike>(watchlist: W[], symbol: string, groupId: string | null): W[] {
  return watchlist.map((w) => (w as W & { symbol: string }).symbol === symbol ? { ...w, groupId } : w);
}

/**
 * 分组视图过滤：all=全部 · none=未分组 · 其余按组 id；
 * 未知/已删的组 id 过滤出空集（页面空态自己有分文案，这里不硬兜成「全部」）。
 */
export function filterWatchlist<W extends WatchLike>(watchlist: W[], filter: "all" | "none" | string): W[] {
  if (filter === "all") return watchlist;
  if (filter === "none") return watchlist.filter((w) => !w.groupId);
  return watchlist.filter((w) => w.groupId === filter);
}
