// 客户端「点开即有内容」缓存层（src/lib/desk/api-cache.ts）的回归测试。
// 用假的 window + fetch 验证四条口径：命中缓存直接回、非 /api/ 透传、变更请求使缓存失效、只接管同源 GET。
import { test } from "node:test";
import assert from "node:assert/strict";

test("API 缓存：同源 GET /api/* 命中直接回；非 /api/ 透传；POST 使同路径缓存失效", async () => {
  const savedWindow = (globalThis as { window?: unknown }).window;
  const calls: string[] = [];
  const realFetch = async (input: unknown) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, n: calls.length }), {
      status: 200,
      headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": "123" },
    });
  };
  (globalThis as { window?: unknown }).window = { location: { origin: "http://localhost:3000" }, fetch: realFetch };
  try {
    const mod = await import("../../src/lib/desk/api-cache.ts");
    mod.clearApiCache();
    const w = (globalThis as unknown as { window: { fetch: (u: string, i?: RequestInit) => Promise<Response> } }).window;

    // 第一次：走真 fetch 并写缓存
    assert.equal((await (await w.fetch("/api/market/themes")).json()).n, 1);
    assert.equal(calls.length, 1);

    // 第二次：命中缓存，不再打接口
    const r2 = await w.fetch("/api/market/themes");
    assert.equal((await r2.json()).n, 1, "命中缓存应回上一次的响应");
    assert.equal(calls.length, 1, "命中缓存不该再打接口");
    // 重建的响应不能带 content-encoding/length（body 已解码，带上会让浏览器按压缩体解析失败）
    assert.equal(r2.headers.get("content-encoding"), null);
    assert.equal(r2.headers.get("content-length"), null);
    assert.equal(r2.headers.get("content-type"), "application/json");

    // 非 /api/：原样透传，不缓存
    await w.fetch("/other");
    assert.equal(calls.length, 2);

    // 变更请求成功后：同路径 GET 缓存失效，下次重新打接口
    await w.fetch("/api/market/themes", { method: "POST" });
    assert.equal(calls.length, 3);
    await w.fetch("/api/market/themes");
    assert.equal(calls.length, 4, "POST 之后 GET 缓存应失效");
  } finally {
    if (savedWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = savedWindow;
  }
});
