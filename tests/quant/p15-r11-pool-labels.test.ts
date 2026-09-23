// R11：candidate_pool 工具读出侧人话化（中文标签）回归测试。
//
// 背景（对应用户所见）：P13 因子中文化只改了页面，工具侧漏改——AI 调 candidate_pool
// 读冻结池时，条件行原样吐 field:"amount_yi" 英文 JSON、名单行吐 symbol/changePct 英文键，
// 模型转述出来就是一串人机腔。本轮把「读法」收进纯核（poolRowZh/poolCondZh），
// 与 pickCondText 同源一份中文字段表。
//
// 红线口径：这是「读出换键名」不是「改写数据」——冻结池 rows/conditions 落库后永不覆盖
// （见 /api/pool/freeze），本函数只在工具返回时换显示；认不出的键原样保留、值一律不动。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  POOL_ROW_KEY_ZH, poolRowZh, poolCondZh, pickCondText, PICK_FIELD_ZH,
} from "../../src/lib/quant/screener/pick-pool-core.ts";

const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

// ---------- 纯核：名单行换键 ----------

test("poolRowZh：冻结行的英文键换成中文读法，值一字不动", () => {
  const row = { symbol: "600519.SH", name: "贵州茅台", close: 1410.0, changePct: 2.35, reason: "手工条件" };
  assert.deepEqual(poolRowZh(row), {
    代码: "600519.SH", 名称: "贵州茅台", 收盘价: 1410.0, "涨跌幅%": 2.35, 入池时条件: "手工条件",
  });
});

test("poolRowZh：认不出的键原样保留（自定义列不丢），null/坏形状不炸", () => {
  const r = poolRowZh({ symbol: "000001.SZ", extra_col: 7 }) as Record<string, unknown>;
  assert.deepEqual(r, { 代码: "000001.SZ", extra_col: 7 });
  assert.equal(poolRowZh(null), null);
  assert.equal(poolRowZh("坏行"), "坏行");
  assert.deepEqual(poolRowZh([1, 2]), [1, 2]);
});

test("poolRowZh：只换键不改数——null 收盘/涨跌原样是 null，不补 0 冒充有读数", () => {
  const r = poolRowZh({ symbol: "X", close: null, changePct: null }) as Record<string, unknown>;
  assert.equal(r.收盘价, null);
  assert.equal(r["涨跌幅%"], null);
});

// ---------- 纯核：条件换读法 ----------

test("poolCondZh：带 field 形状的条件走 pickCondText（与页面/注入块同一份中文表）", () => {
  assert.equal(poolCondZh({ field: "amount_yi", op: ">=", value: 2 }), pickCondText({ field: "amount_yi", op: ">=", value: 2 }));
  assert.equal(poolCondZh({ field: "amount_yi", op: ">=", value: 2 }), `成交额(亿)≥2`);
  // 字段表唯一源：POOL_ROW_KEY_ZH 之外的中文化不得另起炉灶
  assert.ok(PICK_FIELD_ZH.change_pct === "涨跌幅");
});

test("poolCondZh：坏形状/旧格式条件原样透传，不硬凑成人话", () => {
  assert.equal(poolCondZh("成交额大于2亿"), "成交额大于2亿");
  assert.equal(poolCondZh(null), null);
  assert.deepEqual(poolCondZh({ op: ">=", value: 2 }), { op: ">=", value: 2 });
});

// ---------- 服务层接线：源码形状钉 ----------

test("chat-tools 接线：candidate_pool 读出的条件与名单走人话化，不再原样吐英文键", () => {
  const src = readSrc("src/lib/desk/chat-tools.ts");
  assert.match(src, /import \{[^}]*poolRowZh[^}]*poolCondZh[^}]*\} from "@\/lib\/quant\/screener\/pick-pool-core"/);
  assert.match(src, /条件: Array\.isArray\(conditions\) \? conditions\.map\(poolCondZh\) : poolCondZh\(conditions\)/);
  assert.match(src, /名单: rows\.slice\(0, CAP\)\.map\(poolRowZh\)/);
  // 旧英文原文出口已封死：不再有裸 `条件: conditions` / `名单: rows.slice(0, CAP)`
  assert.doesNotMatch(src, /条件: conditions,/);
  assert.doesNotMatch(src, /名单: rows\.slice\(0, CAP\),/);
});

test("只换读法不改数据：poolRowZh/poolCondZh 不写库，freeze 路由落库口径零改动", () => {
  const freezeSrc = readSrc("src/app/api/pool/freeze/route.ts");
  // 冻结仍原样 JSON.stringify(body.rows / body.conditions)，不 import 本轮纯核
  assert.match(freezeSrc, /rows: JSON\.stringify\(body\.rows\)/);
  assert.match(freezeSrc, /conditions: JSON\.stringify\(body\.conditions \?\? \[\]\)/);
  assert.doesNotMatch(freezeSrc, /poolRowZh|poolCondZh/);
  const coreSrc = readSrc("src/lib/quant/screener/pick-pool-core.ts");
  // 纯核零 IO 不破例
  assert.doesNotMatch(coreSrc, /import .*from "(node:fs|@prisma|\/@\/lib\/db)"/);
  assert.ok(POOL_ROW_KEY_ZH.reason === "入池时条件");
});

// ---------- p13 旧钉不回归：missing 分支行为字符串一字未动 ----------

test("p13 旧口径不回归：不带池号不猜池、池不存在如实报，missing 文案一字未动", () => {
  const src = readSrc("src/lib/desk/chat-tools.ts");
  assert.match(src, /未指定池号 pool_id（一次只交一个池，拿错池等于择优选错素材）/);
  assert.match(src, /最近的候选池/);
  assert.match(src, /候选池不存在：\$\{id\}/);
  assert.match(src, /池内共 \$\{rows\.length\} 只，这里只给前 \$\{CAP\} 只/);
});
