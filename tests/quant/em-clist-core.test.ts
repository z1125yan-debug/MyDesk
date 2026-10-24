// 东财 clist diff 双形状解析核 + em.ts 接线口径钉测（2026-10-20 下午分支榜降级根因）。
// 背景：push2delay 镜像出现过 diff 为「下标→行」字典的响应，而取数层只按 HTTP 层判
// 成功、调用方按数组迭代——fetchBoardReal 当场抛错误落腾讯兜底，行业全榜单页静默
// 丢行（okPages 已先行自增，方向完整性闸被架空）。node --test 直跑，零 IO。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clistDiffRows } from "../../src/lib/quant/data/em-clist-core.ts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

test("数组 diff（push2 主站形状）原样返回", () => {
  const rows = [{ f12: "BK1326" }, { f12: "BK1036" }];
  assert.deepEqual(clistDiffRows({ data: { diff: rows } }), rows);
});

test("字典 diff（push2delay 镜像形状）按数字下标升序还原，乱序键不乱行", () => {
  const j = { data: { diff: { "2": { f12: "C" }, "0": { f12: "A" }, "10": { f12: "K" }, "1": { f12: "B" } } } };
  assert.deepEqual(
    (clistDiffRows(j) ?? []).map((r) => r.f12),
    ["A", "B", "C", "K"],
    "必须按数字序（10 在 2 之后），字典序会把第 11 行排到第 3 行",
  );
});

test("坏形状一律 null = 不可用，绝不当空榜：缺 diff / diff 非对象 / 顶层为空", () => {
  assert.equal(clistDiffRows({ data: {} }), null);
  assert.equal(clistDiffRows({ data: { diff: "502" } }), null);
  assert.equal(clistDiffRows({ data: { diff: 42 } }), null);
  assert.equal(clistDiffRows(null), null);
  assert.equal(clistDiffRows(undefined), null);
  assert.equal(clistDiffRows("<html>502</html>"), null);
});

test("空数组/空字典是合法空榜（返回 [] 而非 null）：形状可用与有无数据分开判", () => {
  assert.deepEqual(clistDiffRows({ data: { diff: [] } }), []);
  assert.deepEqual(clistDiffRows({ data: { diff: {} } }), []);
});

test("em.ts 接线：emGet 带形状校验形参，两处 clist 调用都过校验且解析走 clistDiffRows", () => {
  const src = read("src/lib/desk/em.ts");
  assert.match(src, /accept\?: \(j: T\) => boolean/, "emGet 必须有可选形状校验形参（向后兼容）");
  assert.match(src, /if \(accept && !accept\(j\)\) throw new Error\("unexpected payload shape"\)/);
  const validators = src.match(/clistDiffRows\(r\) !== null/g) ?? [];
  assert.equal(validators.length, 2, "fetchBoardReal 与 fetchIndustryBoardUniverse 各过一次形状校验");
  assert.match(src, /const rows = clistDiffRows\(j\) \?\? \[\];/, "板块榜解析走归一化核");
  assert.match(src, /for \(const d of clistDiffRows\(j\) \?\? \[\]\)/, "全榜迭代走归一化核");
  assert.doesNotMatch(src, /j\?\.data\?\.diff \?\? \[\]/, "不许再裸迭代 data.diff（字典形状会当场抛错）");
});

test("em.ts 接线：clist 主机链三台兜底，末位 push2his（push2 与 delay 实测会同时 502）", () => {
  const src = read("src/lib/desk/em.ts");
  assert.match(
    src,
    /const EM_HOSTS = \["https:\/\/push2delay\.eastmoney\.com", "https:\/\/push2\.eastmoney\.com", "https:\/\/push2his\.eastmoney\.com"\];/,
    "EM_HOSTS 必须含 push2his 第三兜底，顺序不许乱（delay 优先是既有口径）",
  );
});
