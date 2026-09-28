// 服务端短 TTL 缓存（src/lib/quant/server-cache.ts）的回归测试：命中/过期/非 200 不缓存/invalidate。
import { test } from "node:test";
import assert from "node:assert/strict";

test("服务端短缓存：TTL 内命中直接回、过期重算、非 200 不写缓存、invalidate 清同前缀", async () => {
  const mod = await import("../../src/lib/quant/server-cache.ts");
  mod.clearServerCache();
  let calls = 0;
  const ok = async () => {
    calls++;
    return new Response(JSON.stringify({ n: calls }), { status: 200, headers: { "content-type": "application/json" } });
  };

  // 第一次算，第二次命中
  assert.equal((await (await mod.ttlCache("t", 1000, ok)).json()).n, 1);
  assert.equal((await (await mod.ttlCache("t", 1000, ok)).json()).n, 1, "TTL 内应回缓存");
  assert.equal(calls, 1);

  // 过期（ttl 传 -1）→ 重算
  await mod.ttlCache("t", -1, ok);
  assert.equal(calls, 2, "过期后应重算");

  // 非 200 不缓存：每次都真跑
  const bad = async () => { calls++; return new Response("boom", { status: 502 }); };
  await mod.ttlCache("bad", 1000, bad);
  await mod.ttlCache("bad", 1000, bad);
  assert.equal(calls, 4, "502 不该被缓存");

  // invalidate 清掉同前缀（"events" 覆盖 "events" / "events?..." / "events/..."）
  await mod.ttlCache("events", 1000, ok);
  await mod.ttlCache("events/history", 1000, ok);
  const before = calls;
  mod.invalidateServerCache("events");
  await mod.ttlCache("events", 1000, ok);
  await mod.ttlCache("events/history", 1000, ok);
  assert.equal(calls, before + 2, "invalidate 后两个 key 都应重算");

  mod.clearServerCache();
  assert.equal(mod.serverCacheSize(), 0);
});
