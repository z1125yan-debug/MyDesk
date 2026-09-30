/**
 * 验证 server-cache 的 SWR 三段式是否真生效：HIT（新鲜秒回）→ STALE（过期秒回旧值+后台刷新）。
 * 判据看响应头 x-cache / x-cache-age，以及实测耗时（关键：过期后也不许让用户等）。
 */
const BASE = "http://127.0.0.1:3000";

async function hit(path: string, label: string): Promise<void> {
  const t0 = Date.now();
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await fetch(BASE + path, { signal: ctl.signal });
    clearTimeout(tm);
    const ms = Date.now() - t0;
    await r.text();
    console.log(
      label.padEnd(22) +
        " http=" + r.status +
        " " + String(ms + "ms").padEnd(8) +
        " x-cache=" + (r.headers.get("x-cache") ?? "-") +
        " age=" + (r.headers.get("x-cache-age") ?? "-") + "s",
    );
  } catch (e) {
    clearTimeout(tm);
    console.log(label.padEnd(22) + " FAILED " + String((e as Error).message).slice(0, 50) + " (" + (Date.now() - t0) + "ms)");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // sentiment 走 DEFAULT_TTL_MS=60s
  console.log("--- /api/market/sentiment（TTL 60s）---");
  await hit("/api/market/sentiment", "① 首次（应 MISS/同步算）");
  await hit("/api/market/sentiment", "② 立刻再调（应 HIT）");
  console.log("   等 65s 让 TTL 过期…");
  await sleep(65_000);
  await hit("/api/market/sentiment", "③ 过期后（应 STALE+秒回）");
  await sleep(3000);
  await hit("/api/market/sentiment", "④ 后台刷新完（应 HIT）");
}

main();
