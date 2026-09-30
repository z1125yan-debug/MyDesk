// 钉住 server-cache 的 SWR（stale-while-revalidate）行为。
//
// 为什么要钉：2026-09-30 用户「打开加载太慢、点预测什么也没出来」的根因就在这里——
// TTL 一过，第一个请求被迫扛下整个重算（实测 5s/11s/41s/45s），用户干等。
// SWR 的契约是：**过期不许阻塞**，秒回旧值 + 后台重算。钉死它，防以后有人改回「过期就等」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ttlCache, clearServerCache } from "../../src/lib/quant/server-cache.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jsonProducer(calls: { n: number }, delayMs: number) {
  return async () => {
    calls.n += 1;
    await sleep(delayMs);
    return new Response(JSON.stringify({ ok: true, n: calls.n }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

test("TTL 内重复请求只算一次（HIT，不重复调 producer）", async () => {
  clearServerCache();
  const calls = { n: 0 };
  const produce = jsonProducer(calls, 10);
  const r1 = await ttlCache("swr-hit", 60_000, produce);
  assert.equal(calls.n, 1, "首次应该真算一次");
  const r2 = await ttlCache("swr-hit", 60_000, produce);
  assert.equal(calls.n, 1, "TTL 内第二次不该再算");
  assert.equal(r2.headers.get("x-cache"), "HIT");
  assert.equal((await r2.json()).n, 1);
  assert.equal((await r1.json()).n, 1);
});

test("TTL 过期后 STALE 秒回旧值，且后台把新值刷进去", async () => {
  clearServerCache();
  const calls = { n: 0 };
  // producer 故意慢（300ms）：如果 STALE 没生效，这个测试会明显等 300ms 才返回
  const produce = jsonProducer(calls, 300);

  const r1 = await ttlCache("swr-stale", 60, produce);
  assert.equal(calls.n, 1);

  await sleep(80); // 让 60ms TTL 过期

  const t0 = Date.now();
  const r2 = await ttlCache("swr-stale", 60, produce);
  const cost = Date.now() - t0;
  assert.equal(r2.headers.get("x-cache"), "STALE", "过期但仍在宽限窗口内必须回旧值");
  assert.ok(cost < 150, `STALE 必须秒回，实际 ${cost}ms——说明又让用户等重算了`);
  assert.equal((await r2.json()).n, 1, "STALE 回的是旧值");

  // 后台刷新完成后应拿到新值
  // （注意：这里不断言 x-cache=HIT——TTL 只有 60ms，刷新完随即又过期了，标记会回到 STALE。
  //   「刷新后回到 HIT」由下一个用例用更长的 TTL 单独钉。）
  await sleep(500);
  const r3 = await ttlCache("swr-stale", 60, produce);
  assert.equal((await r3.json()).n, 2, "后台刷新应把新值写进缓存");
});

test("后台刷新完成后回到 HIT（TTL 足够长时）", async () => {
  clearServerCache();
  const calls = { n: 0 };
  const produce = jsonProducer(calls, 50); // 刷新耗时 50ms
  const TTL = 400; // 大于刷新耗时，刷新完仍在 TTL 内
  await ttlCache("swr-refreshed", TTL, produce);
  await sleep(450); // 越过 TTL
  const r2 = await ttlCache("swr-refreshed", TTL, produce);
  assert.equal(r2.headers.get("x-cache"), "STALE");
  await sleep(150); // 等后台 50ms 刷新落库
  const r3 = await ttlCache("swr-refreshed", TTL, produce);
  assert.equal(r3.headers.get("x-cache"), "HIT", "刷新完后应回到新鲜");
  assert.equal((await r3.json()).n, 2);
});

test("无缓存时首次请求同步算（冷启动，靠预热规避）", async () => {
  clearServerCache();
  const calls = { n: 0 };
  const r1 = await ttlCache("swr-cold", 60_000, jsonProducer(calls, 10));
  assert.equal(calls.n, 1);
  assert.equal(r1.headers.get("x-cache"), null, "首次走 producer 原样返回，不带缓存标记");
});
