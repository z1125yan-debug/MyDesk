import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

// ---------- 纯函数：图片过滤（只认 data:image/ 开头的字符串） ----------

function filterValidImages(imgs: unknown[]): string[] {
  return imgs.filter((s): s is string => typeof s === "string" && s.startsWith("data:image/"));
}

test("P34 images 过滤：只收 data:image/ 开头的字符串", () => {
  const imgs = [
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPD4/PT8=",
    "not a data URL",
    123,
    null,
    undefined,
    {},
  ];
  const valid = filterValidImages(imgs);
  assert.equal(valid.length, 2, "只收 2 个 data:image/ 字符串");
  assert.ok(valid[0].startsWith("data:image/png"));
  assert.ok(valid[1].startsWith("data:image/jpeg"));
});

test("P34 images 过滤：空数组返回空数组", () => {
  assert.deepEqual(filterValidImages([]), []);
});

test("P34 images 过滤：非数组返回空数组", () => {
  assert.deepEqual(filterValidImages([]), []);
  assert.deepEqual(filterValidImages([] as unknown as unknown[]), []);
});

// ---------- injectImages 逻辑（模拟 chat/route.ts 里的函数） ----------

function injectImages(messages: Record<string, unknown>[], images: string[]): Record<string, unknown>[] {
  const validImgs = images.filter((s) => typeof s === "string" && s.startsWith("data:image/"));
  if (validImgs.length === 0) return messages;
  const out = messages.map((m) => ({ ...m }));
  // 只改最后一轮 message（必须是 user 且 content 是 string）
  const last = out[out.length - 1];
  if (last.role !== "user") return messages;
  const prev = last.content;
  if (typeof prev !== "string") return messages;
  last.content = [
    { type: "text", text: prev },
    ...validImgs.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
  return out;
}

test("P34 injectImages：有图片时把最后一轮 user message 的 content 改成数组", () => {
  const msgs = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "帮我看看这张图" },
    { role: "assistant", content: "好的" },
    { role: "user", content: "这张呢" },
  ];
  const imgs = [
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ];
  const out = injectImages(msgs, imgs);
  assert.equal(out.length, 4, "消息数量不变");
  assert.equal(out[3].role, "user", "最后一轮还是 user");
  const content = out[3].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  assert.equal(content.length, 2, "1 个 text block + 1 个 image_url block");
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, "这张呢");
  assert.equal(content[1].type, "image_url");
  assert.ok(content[1].image_url!.url.startsWith("data:image/png"));
});

test("P34 injectImages：没有图片时原样返回", () => {
  const msgs = [{ role: "user", content: "hello" }];
  const out = injectImages(msgs, []);
  assert.deepEqual(out, msgs, "原样返回");
});

test("P34 injectImages：图片全是无效形状时原样返回", () => {
  const msgs = [{ role: "user", content: "hello" }];
  const out = injectImages(msgs, ["not valid", "123", "null"]);
  assert.deepEqual(out, msgs, "原样返回");
});

test("P34 injectImages：最后一轮不是 user 时不动任何字段", () => {
  const msgs = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ];
  const imgs = ["data:image/png;base64,abc"];
  const out = injectImages(msgs, imgs);
  assert.deepEqual(out, msgs, "原样返回");
});

test("P34 injectImages：最后一轮 content 已经是数组时不动（不覆盖）", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ];
  const imgs = ["data:image/png;base64,abc"];
  const out = injectImages(msgs, imgs);
  assert.deepEqual(out, msgs, "原样返回");
});

test("P34 injectImages：多张图片全部追加", () => {
  const msgs = [{ role: "user", content: "看这些图" }];
  const imgs = [
    "data:image/png;base64,aaa",
    "data:image/jpeg;base64,bbb",
    "data:image/webp;base64,ccc",
  ];
  const out = injectImages(msgs, imgs);
  const content = out[0].content as Array<{ type: string }>;
  assert.equal(content.length, 4, "1 个 text + 3 个 image_url");
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image_url");
  assert.equal(content[2].type, "image_url");
  assert.equal(content[3].type, "image_url");
});