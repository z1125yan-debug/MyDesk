// P2-自动化 服务进程启动钩子（Next 16 instrumentation：服务启动时执行一次，与是否有客户端打开页面无关）
//
// 这里启动的是「服务端进程内调度器」：
// - 网页关闭 → 只要服务进程在跑，收盘后仍会扫描；
// - 服务进程未启动 → 不会有任何自动扫描（这条边界写进 task_run 与页面文案，不宣称无人值守）。
//
// 只想跑一次性脚本/测试时可用 DESK_SCHEDULER=0 关掉；
// DESK_SCHEDULER_DELAY_MIN / DESK_SCHEDULER_MAX_ATTEMPTS 调等待时长与重试上限。
//
// 另外：开机后 best-effort **预热只读接口**（见 warmApiCache）——把算得慢的 GET 先跑一遍填进
// 服务端短缓存（server-cache），配合客户端 SWR（api-cache），第一次点开菜单就能直接命中。
// 关掉预热：DESK_WARM=0。
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // Edge runtime 无定时器/无 DB
  const { startScheduler } = await import("@/lib/quant/scheduler/index");
  startScheduler();
  warmApiCache();
}

/** 开机预热的目标：主菜单页首屏会用到的、算得慢的只读接口（与各 route 的缓存 key 一致）。
 *  2026-09-29 用户：「优化一下所有菜单打开的缓存」——名单扩到**每个主菜单页的首屏接口**，
 *  并与客户端声明表（src/lib/desk/prefetch-map.ts）保持一致：服务端先热，客户端再按同表预取。
 *  口径：只列「可安全重复拉」的只读 GET；参数必须与页面真实默认值一致（缓存键含 query）。 */
const WARM_TARGETS = [
  // 大盘情绪
  "/api/market/sentiment",
  "/api/market/limitup",
  "/api/market/trend",
  "/api/market/review-stats",
  "/api/market/breadth?days=30&scope=all_markets",
  // 风险监控（冷启动实测 13s：情绪快照 + 相似环境检索）
  "/api/market/risk",
  // 设置页模型通道状态（读取本身很轻，但首次命中要等路由编译）
  "/api/llm/config",
  // 量化因子选股
  "/api/quant/factors?catalog=1",
  "/api/quant/strategy-library?limit=2000",
  "/api/quant/screener/trade-dates",
  "/api/quant/factor-matrix",
  // 行业（榜 + 跨市场/见顶风险）
  "/api/market/sectors?kind=industry",
  "/api/market/sectors/cross-market",
  "/api/market/sectors/top-risk",
  // 行情组：数据看板 / 全A列表
  "/api/market/board?kind=industry&dir=in",
  "/api/market/board?kind=industry&dir=out",
  "/api/market/allstocks?page=1&page_size=50&order_by=amount_yi&dir=desc",
  // 事件雷达 / LLM分析 / 主题热点 / 研究池
  "/api/events",
  "/api/events/history",
  "/api/market/themes",
  "/api/market/theme-heat",
  "/api/radar",
  "/api/pool/list",
  // 研报「受益标的」核对用的全 A 名册：单次要拉全量代码表（东财断源时走腾讯兜底更慢），
  // 不预热的话用户点完生成才第一次算，校验条会长时间停在"核对中"。
  "/api/market/stock-names",
  // 2026-09-30 补：这两个是全场最慢的两个（实测冷启动 41s / 45s+），却在原预热名单里，
  // 导致「点预测按钮白等一分钟、技术信号页打不开」。放**最后**（串行预热，慢的别挡住快的）。
  "/api/quant/strategy-forecast",
  "/api/market/signals",
];

function warmApiCache(): void {
  if (process.env.DESK_WARM === "0") return;
  const port = process.env.PORT || "3000";
  const base = `http://127.0.0.1:${port}`;
  // 服务可能还没开始监听：等几秒再打；**串行**跑，避免开机就把机器/上游打满。
  setTimeout(() => {
    void (async () => {
      let ok = 0;
      for (const path of WARM_TARGETS) {
        try {
          const res = await fetch(base + path, { cache: "no-store" });
          await res.arrayBuffer().catch(() => {});
          if (res.ok) ok++;
        } catch {
          // 预热失败不影响启动：真正的请求还会再算一次
        }
      }
      console.log(`[warm] 只读接口预热完成 ${ok}/${WARM_TARGETS.length}（base=${base}）`);
    })();
  }, 4000);
}
