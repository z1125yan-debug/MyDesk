// P2-自动化 服务进程启动钩子（Next 16 instrumentation：服务启动时执行一次，与是否有客户端打开页面无关）
//
// 这里启动的是「服务端进程内调度器」：
// - 网页关闭 → 只要服务进程在跑，收盘后仍会扫描；
// - 服务进程未启动 → 不会有任何自动扫描（这条边界写进 task_run 与页面文案，不宣称无人值守）。
//
// 只想跑一次性脚本/测试时可用 DESK_SCHEDULER=0 关掉；
// DESK_SCHEDULER_DELAY_MIN / DESK_SCHEDULER_MAX_ATTEMPTS 调等待时长与重试上限。
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // Edge runtime 无定时器/无 DB
  const { startScheduler } = await import("@/lib/quant/scheduler/index");
  startScheduler();
}
