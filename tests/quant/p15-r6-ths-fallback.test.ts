// P15-R6 同花顺板块资金流兜底钉测（东财 push2 复发断源，GitHub 主流库大多同上游，换库不换源）。
//
// 红线：
//  1. 解析是零 IO 纯函数——真页 GBK 解码后的行样本直接喂 parseThsRows，字段逐列对位；
//  2. 同花顺 code 必须带 THS 前缀、secid 必须留空：日K/资金明细/扩散度自然落缺失，
//     绝不拿同花顺码去拼东财 secid 错接别家板块的数据（串源比缺数更坏）；
//  3. 只有东财+腾讯兜底都拿不到资金读数才整榜换同花顺；东财正常时主链路零变化；
//  4. 口径差异（净额=流入−流出、无超大单拆分、榜按涨幅取前 N）必须落 missing/来源行，不冒充东财字段；
//  5. 三源全断的报错保留旧「腾讯」子串（p8 钉）并追加同花顺。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseThsRows } from "../../src/lib/desk/ths.ts";

const THEME_SRC = readFileSync(new URL("../../src/lib/quant/screener/themes.ts", import.meta.url), "utf8");

// 2026-09-23 实测页原样行（GBK→UTF-8 解码后），列序：序号|行业|指数|涨幅|流入|流出|净额|家数|领涨股|领涨涨幅|价
const INDUSTRY_TR =
  '<tr><td class="first tc">1</td><td class="tl"><a href="http://q.10jqka.com.cn/thshy/detail/code/881164/" target="_blank">文化传媒</a></td>' +
  "<td class=\"\">2831.33</td><td class=\"tr cur c-rise\">3.15%</td><td class=\"tr\">162.54</td><td class=\"tr\">129.86</td>" +
  "<td class=\"tr c-rise\">32.68</td><td class=\"tr\">85</td><td class=\"tc\"><a href=\"http://stockpage.10jqka.com.cn/000676/\" target=\"_blank\">智度股份</a></td>" +
  "<td class=\"tr c-rise\">10.04%</td><td class=\"tr c-rise\">7.45</td></tr>";
const CONCEPT_TR =
  '<tr><td class="first tc">1</td><td class="tl"><a href="http://q.10jqka.com.cn/gn/detail/code/309182/" target="_blank">小红书概念</a></td>' +
  "<td class=\" c-rise\">1502.57</td><td class=\"tr cur c-rise\">2.70%</td><td class=\"tr c-rise\">132.61</td><td class=\"tr c-fall\">111.03</td>" +
  "<td class=\"tr c-rise\">21.58</td><td class=\"tr\">55</td><td class=\"tc\"><a href=\"http://stockpage.10jqka.com.cn/688365/\" target=\"_blank\">光云科技</a></td>" +
  "<td class=\"tr c-rise\">13.91%</td><td class=\"tr c-rise\">16.70</td></tr>";
// 负读数样本（白酒页 2 实测行变形）：涨幅负、净额负不能解析成 0
const FALL_TR =
  '<tr><td>51</td><td><a href="http://q.10jqka.com.cn/thshy/detail/code/881180/">白酒</a></td><td>1978.1</td><td>-0.16%</td>' +
  "<td>27.15</td><td>27.65</td><td>-0.50</td><td>19</td><td>口子窖</td><td>0.84%</td><td>17.97</td></tr>";

test("解析对位：行业真页行 → 名称/涨幅/流入/流出/净额/家数/领涨股 逐列正确，code 带 THS 前缀", () => {
  const [r] = parseThsRows(INDUSTRY_TR);
  assert.equal(r.code, "THS881164", "同花顺码必须带 THS 前缀（防与东财 BK 码串源）");
  assert.equal(r.name, "文化传媒");
  assert.equal(r.changePct, 3.15);
  assert.equal(r.inflowYi, 162.54);
  assert.equal(r.outflowYi, 129.86);
  assert.equal(r.netYi, 32.68);
  assert.equal(r.count, 85);
  assert.equal(r.leader, "智度股份");
  assert.equal(r.leaderPct, 10.04);
});

test("概念榜 href 是 gn 系：同样解析出 THS 前缀码", () => {
  const [r] = parseThsRows(CONCEPT_TR);
  assert.equal(r.code, "THS309182");
  assert.equal(r.name, "小红书概念");
  assert.equal(r.netYi, 21.58);
});

test("负读数不解析成 0：跌幅、净流出照实回负值", () => {
  const [r] = parseThsRows(FALL_TR);
  assert.equal(r.changePct, -0.16);
  assert.equal(r.netYi, -0.5);
});

test("杂散行剔除：不足 11 列的表头/空名行不进榜", () => {
  const junk = "<tr><td>序号</td><td>行业</td><td>指数</td></tr>" + "<tr><td>1</td><td></td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td><td>7</td><td>8</td><td>9</td><td>10</td></tr>";
  assert.equal(parseThsRows(junk).length, 0, "列数不足或名称为空都不该产出假行");
  assert.equal(parseThsRows("<div>不是表格</div>").length, 0);
});

test("兜底触发口径：只在东财+腾讯都拿不到资金读数时整榜换同花顺；东财正常零变化", () => {
  assert.match(THEME_SRC, /const hasEmFunds = \[\.\.\.industry0, \.\.\.concept0\]\.some\(\(r\) => !r\.fundsMissing\)/, "触发判据=榜上没有任何一条真资金行");
  assert.match(THEME_SRC, /if \(!hasEmFunds \|\| !concept0\.length\)/, "东财正常且概念有数时根本不打同花顺");
  assert.match(THEME_SRC, /thsToBoardRow/, "同花顺行经统一映射进 BoardRow");
});

test("不串源：同花顺行 secid 留空、code 带前缀——日K/资金明细/扩散自然落缺失", () => {
  assert.match(THEME_SRC, /secid: "",/, "同花顺没有东财 secid 口径，留空让 streak/kline 走无数据分支");
  assert.match(THEME_SRC, /code: r\.code,/, "code 用 ths.ts 里已加 THS 前缀的码");
});

test("口径诚实：净额=流入−流出、无超大单拆分、按涨幅取前 N 都落 missing/来源行", () => {
  assert.match(THEME_SRC, /同花顺榜只有净额（流入−流出）口径/, "missing 登记拆分缺失与取榜深度");
  assert.match(THEME_SRC, /同花顺板块资金流榜（东财板块榜\/资金读数断源时的独立兜底/, "来源行自报出身与口径");
});

test("三源全断报错：保留 p8 钉的旧子串并追加同花顺", () => {
  assert.match(THEME_SRC, /东财榜单接口与腾讯板块兜底均无返回；同花顺兜底亦无返回/);
});

test("同花顺资金行不置 fundsMissing：主读数照实显示，不被腾讯占位纪律误伤", () => {
  const mapIdx = THEME_SRC.indexOf("function thsToBoardRow");
  assert.ok(mapIdx > 0);
  const body = THEME_SRC.slice(mapIdx, THEME_SRC.indexOf("\n}", mapIdx));
  assert.ok(!/fundsMissing: true/.test(body), "同花顺净额是真数，fundsMissing 只能留给腾讯占位 0");
});

test("徽标出身跟着来源走：断源换榜后不再谎称「东财板块」", () => {
  const page = readFileSync(new URL("../../src/components/desk/pages/ThemeOverviewPage.tsx", import.meta.url), "utf8");
  assert.match(page, /source=\{boardSource\}/, "徽标必须吃动态出身");
  assert.match(page, /\? "同花顺资金流" :/, "同花顺兜底时徽标自报同花顺");
  assert.ok(!/source="东财板块"/.test(page), "不许再写死东财板块");
});
