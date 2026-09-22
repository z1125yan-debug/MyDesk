// R10 扩容轮钉：AI「知道数据」三件套——公司名→代码解析、个股新闻/公告工具、
// 消息面进个股分析预取与提示词纪律（用户口径：除了技术还要结合新闻回答，数据都得是真的）。
// 纯行为钉（nameCandidates/classifyIntent/planDispatch 可直跑）+ 源码形状钉（服务层带 IO，按 P13 先例读源码）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  classifyIntent,
  nameCandidates,
  planDispatch,
  scenePrompt,
  symbolSourceLabel,
  symbolSourceText,
} from "../../src/lib/desk/intent-core.ts";

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf-8");
const stockNews = read("src/lib/desk/stock-news.ts");
const chatTools = read("src/lib/desk/chat-tools.ts");
const route = read("src/app/api/ai/chat/route.ts");
const sceneDispatch = read("src/lib/desk/scene-dispatch.ts");
const skills = read("src/lib/desk/skills-core.ts");
const intentCoreSrc = read("src/lib/desk/intent-core.ts");

// ---------- 纯核：候选名提取（只提议不断言） ----------

test("nameCandidates：剔掉疑问/场景词后露出的连续中文名段才是候选", () => {
  assert.deepEqual(nameCandidates("中国电影卖的怎么样"), ["中国电影"]);
  assert.deepEqual(nameCandidates("对比中国电影和华策影视"), ["中国电影", "华策影视"]);
  assert.deepEqual(nameCandidates("中国海油还能买吗"), ["中国海油"]);
  // 带代码 / 纯场景词不该出候选
  assert.deepEqual(nameCandidates("600977 怎么了"), []);
  assert.deepEqual(nameCandidates("今天大盘整体怎么样"), []);
  assert.deepEqual(nameCandidates("我的自选股现在整体表现如何"), []);
  // 去重与上限（候选最多 5 个，不给服务层塞无界的搜索请求）
  assert.ok(nameCandidates(" ".repeat(3)).length === 0);
  const many = nameCandidates("中国电影 华策影视 上海电影 光线传媒 万达电影 北京文化 幸福蓝海");
  assert.ok(many.length <= 5 && many[0] === "中国电影", "候选封顶 5 个按出现顺序");
});

test("classifyIntent：nameHits 只在没代码时升格为标的，出处如实标 name；带代码时代码优先", () => {
  const hits = [{ name: "中国电影", symbol: "600977.SH" }];
  const byName = classifyIntent({ question: "中国电影卖的怎么样", nameHits: hits });
  assert.equal(byName.scene, "stock_analysis", "「怎么样」起判个股分析");
  assert.equal(byName.symbol, "600977.SH");
  assert.equal(byName.symbolSource, "name");
  assert.deepEqual(byName.symbols, ["600977.SH"]);

  const byCode = classifyIntent({ question: "600519 最近怎么样", nameHits: hits });
  assert.equal(byCode.symbol, "600519.SH", "用户自己写的代码比名字搜索出来的可信，nameHits 靠边站");
  assert.equal(byCode.symbolSource, "question");

  const none = classifyIntent({ question: "中国电影卖的怎么样" });
  assert.equal(none.symbol, null, "没查证就没有标的：纯层与调度都不许拿猜的名字充当事实");
  assert.equal(none.symbolSource, "none");
  assert.match(symbolSourceText("name"), /公司名/, "出处文案要说清是搜出来的");
  // R10b 走查抓到：Debug 意图行曾把原始键直接上屏（「来源：name」）。取词函数不许漏原始键，
  // 也不许把历史留底里本来就是人话的值改判成「未标注」。
  assert.equal(symbolSourceLabel("name"), symbolSourceText("name"), "原始键 → 判定层人话（单一出处）");
  assert.equal(symbolSourceLabel("提问内代码"), "提问内代码", "认不出的输入原样透传（旧留底不许被改写）");
});

test("名字落标后：预取计划与场景提示词都按真标的走，消息面进必读", () => {
  const intent = classifyIntent({ question: "中国电影卖的怎么样", nameHits: [{ name: "中国电影", symbol: "600977.SH" }] });
  const { calls } = planDispatch({ intent });
  const tools = calls.map((c) => c.tool);
  for (const need of ["stock_snapshot", "stock_kline_summary", "stock_fund_flow", "stock_news"]) {
    assert.ok(tools.includes(need), `${need} 随个股分析预取`);
  }
  const news = calls.find((c) => c.tool === "stock_news");
  assert.deepEqual(news?.args, { symbol: "600977.SH" }, "预取直接吃解析出来的代码");
  assert.match(news?.reason ?? "", /新闻\/公告/, "步骤里写清为什么取它");
  const prompt = scenePrompt("stock_analysis", { intent });
  assert.match(prompt, /stock_news/, "场景提示词点名消息面义务");
  assert.match(prompt, /宏观快讯不能替代个股消息面|宏观快讯替代不了/, "不许拿宏观凑个股的账");
  assert.match(prompt, /本轮是纯行情数据判断/, "没消息要自报纯行情判断");
});

// ---------- 服务层源码形状钉 ----------

test("stock-news.ts：解析全等优先、无前缀多义不认、砍尾缀只试一次；排除非个股；接口失败回 null 不冒充空", () => {
  assert.match(stockNews, /const exact = stocks\.find\(\(r\) => r\.name === q\);/, "全称一字不差仍是第一优先（中国电影→600977 零回归）");
  assert.match(stockNews, /const stocks = rows\.filter\(\(r\) => !\/指数\|基金\|ETF\|债\|回购\/\.test\(r\.type\)\);/, "指数/基金同名先剔除，全等与前缀都在个股堆里判");
  assert.match(stockNews, /const prefixed = stocks\.filter\(\(r\) => r\.name\.startsWith\(q\)\);/, "没有全等时看「以候选名开头」的全称（R10c：长鑫→长鑫科技）");
  assert.match(stockNews, /prefixed\.length === 1/, "唯一命中才认：「平安」对到一票同名的票照样不猜");
  assert.match(stockNews, /const base = q\.replace\(ORG_SUFFIX, ""\);[\s\S]{0,120}lookupStock\(base\)/, "全查不中只允许砍一个组织形式词尾缀再试（长鑫存储→长鑫→长鑫科技）");
  assert.match(stockNews, /base\.length < 2\) return null/, "砍剩单字就作罢，不给两字以内缩写开门");
  assert.match(stockNews, /matchKind: NameMatchKind/, "命中方式随结果交出，自报行才说得清出身");
  assert.match(stockNews, /import \{ searchReal \} from "\.\/em"|from "\.\/em"/, "名字解析复用 em 的搜索建议（em.ts 零改动）");
  assert.match(stockNews, /search-api-web\.eastmoney\.com\/search\/jsonp\?cb=x/, "新闻接口必须带 cb（无 cb 实测 400）");
  assert.match(stockNews, /np-anotice-stock\.eastmoney\.com\/api\/security\/ann/, "公告走披露列表");
  assert.match(stockNews, /sort: "time"/, "新闻按时间倒序，老黄历不配进论据");
  assert.match(stockNews, /if \(!res\.ok\) return null/, "非 200＝失败回 null");
  assert.match(stockNews, /catch \{\s*return null;?\s*\}/, "解析炸了也回 null：失败与空是两件事");
});

test("chat-tools：stock_news 注册进 TOOLS；带 symbol 的取数工具统一走 resolveSymbolArg（代码或公司名）", () => {
  assert.ok(chatTools.includes(`name: "stock_news"`), "stock_news 在 TOOLS 里（模型自取与预取共用同一本体）");
  assert.match(chatTools, /宏观快讯（market_news）替代不了/, "注册注释把事故现场钉在表旁边");
  const uses = (chatTools.match(/await resolveSymbolArg\(|=> resolveSymbolArg\(/g) ?? []).length;
  assert.ok(uses >= 9, `九个带标的入口的工具都认名字（实数 ${uses} 处）`);
  assert.match(chatTools, /不能命中不猜代码|不命中不猜代码|绝不凭印象猜代码/, "解析不中＝missing，不猜");
  assert.match(chatTools, /是没搜到，不是取数失败/, "空列表必须自报「没搜到」而非断源");
  assert.match(chatTools, /这是取数失败，不是「这只票没有消息」/, "双源全挂的话术不许伪装成没消息");
});

test("scene-dispatch：名字验证只在无代码时发生；预取步骤标签覆写两处调用都挂", () => {
  assert.match(sceneDispatch, /if \(!extractSymbols\(question\)\.length\) \{/, "带代码的提问一次搜索都不打（零回归）");
  assert.match(sceneDispatch, /nameHits,/);
  const labelUses = (sceneDispatch.match(/labelFor: prefetchLabel/g) ?? []).length;
  assert.equal(labelUses, 2, "首跑与 P8-④ 补轮都要用人话标签，不能补轮退回「调用 stock_news」");
  assert.match(sceneDispatch, /stock_news: "取个股新闻与公告/, "步骤条文案是人话不是工具名");
});

test("skills-core：stock_news 进个股分析 per_symbol 且 required（消息面是主数据不是加分项）", () => {
  assert.match(skills, /name: "stock_news"[\s\S]{0,200}scene: "stock_analysis", spread: "per_symbol"[\s\S]{0,80}required: true/);
  assert.match(skills, /stock_analysis: \[[^\]]*"stock_news"[^\]]*\]/, "SCENE_PREFERS 同步登记");
});

test("提示词纪律：第 3 条并行清单带 stock_news 与公司名口径，第 7 条个股消息面必读", () => {
  assert.match(route, /stock_fund_flow \+ stock_news/, "第 3 条清单收口在工具环");
  assert.match(route, /symbol 直接传公司名/, "模型知道名字可以直传");
  assert.match(route, /谈个股必须引用这只票自己的 stock_news/, "第 7 条区分了宏观与个股");
  assert.match(route, /宏观快讯替代不了个股消息面/);
  assert.match(route, /暂无相关新闻，本轮是纯行情数据判断/, "R10 v1 的兜底话术原样保住");
});

// ---------- R10b 增补：客户端快照与价位校验的锚错票修正 ----------
// 3014 实机事故：问「中国电影卖的怎么样」，服务端把名字解析成 600977（13.55 元）答得全对，
// 客户端 questionCandidates 却切不出「中国电影」（旧切法只产出整句/「中国电影卖」，搜索接口全不认），
// 快照落回分析页关注品种（一只千元票），价位校验拿 1121 元的锚判 13.55 元的回答＝假幻觉拦截 + 误导警告。

const useChat = read("src/lib/desk/use-chat.ts");
const assistantPage = read("src/components/desk/pages/AssistantPage.tsx");

test("客户端候选名与服务端 nameCandidates 同一口径（公司名进搜索候选）", () => {
  assert.match(assistantPage, /import \{ nameCandidates \} from "@\/lib\/desk\/intent-core"/, "共用纯核那份切法，不再各养一套停用词");
  assert.match(assistantPage, /for \(const n of nameCandidates\(q\)\) out\.add\(n\)/, "候选直接并进 questionCandidates");
  assert.match(assistantPage, /slice\(0, 5\)/, "候选上限与服务端一致（5 个）");
});

test("价位校验有适用性闸：锚的不是本轮答的那只票就不判", () => {
  assert.match(useChat, /anchorSymbol\?: string \| null;/, "快照要交代 guardPrice 是从哪只票来的");
  assert.match(assistantPage, /anchorSymbol: gi >= 0 \? targets\[gi\] : null/, "交出的标的与交出的价必须同一块（不能价是 A 的、锚写 B）");
  assert.match(useChat, /anchorMismatch[\s\S]{0,160}code6\(cur\.intent\.symbol\) !== code6\(snap\.anchorSymbol\)/, "对账用 6 位号段，带不带后缀都认");
  assert.match(useChat, /const guard = anchorMismatch \? null : snap\?\.guardPrice \?\? null;/, "锚错票时校验整体跳过：宁可少一次拦截，不多一次假幻觉");
});

test("Debug 意图行的来源一格用人话（原始键不上屏，走查抓到「来源：name」）", () => {
  const debugCore = read("src/lib/desk/debug-core.ts");
  assert.match(debugCore, /import \{ symbolSourceLabel \} from "\.\/intent-core\.ts"/, "取词回判定层单一出处，呈现层不抄第二份");
  assert.match(debugCore, /（来源：\$\{symbolSourceLabel\(symbolSource\)\}）/, "意图行渲染前过一遍人话化");
});

// ---------- R10c：名字落标断链事故（3014 实测「那长鑫呢」被答成「长鑫存储无公开上市A股代码」） ----------
// 真相：长鑫科技 688825.SH 已于 2026-07 登陆科创板，searchReal("长鑫") 当场能搜到——
// 断在 resolveStockName 只认全等（「长鑫」≠「长鑫科技」）把查证结果丢弃，模型再拿「没查到」编出「未上市」。
// 两头都钉：解析放宽到唯一前缀命中（上面 stock-news 形状钉），话术加闸「没搜到≠不存在」（本块）。

test("R10c 话术闸：解析失败只说「没匹配到代码」，禁止反推成「未上市」这种市场事实", () => {
  const intent = classifyIntent({ question: "中国电影卖的怎么样" }); // 名字没经服务层查证 → 无标的
  assert.equal(intent.symbol, null);
  const prompt = scenePrompt("stock_analysis", { intent });
  assert.match(prompt, /没能匹配到可交易的代码/, "缺标的话术只自报没查到");
  assert.match(prompt, /禁止反过来断言「该公司未上市\/没有上市代码」这类市场事实/, "未上市是要查证的断言，不是解析失败的推论");
  assert.match(prompt, /没搜到不等于不存在/);
});

test("R10c 口径如实：前缀命中在自报行、出处文案、递棒三处都留痕", () => {
  assert.match(chatTools, /唯一命中全称「\$\{r\.resolvedName\}」/, "工具返回的自报行写清是简称唯一命中的全称，不是用户报的名");
  assert.match(chatTools, /砍掉组织形式词尾缀后经东财搜索唯一命中/, "砍尾缀命中（长鑫存储）也走独立自报行");
  assert.match(chatTools, /全称是搜索接口给的，不是联想的/, "自报行顺带把自己怎么来的交代干净");
  assert.match(symbolSourceText("name"), /全等或简称唯一命中全称/, "徽章/提示词的出处文案同步放宽口径");
  assert.match(sceneDispatch, /matchKind: h\.matchKind/, "命中方式随 nameHits 递进判定层（纯层签名带可选 matchKind 接收）");
  assert.match(intentCoreSrc, /matchKind\?: "exact" \| "prefix" \| "suffix"/, "IntentInput.nameHits 类型登记三种命中方式");
  assert.match(route, /没搜到不等于不存在/, "工具环纪律第 3 条与场景提示词同一条话术闸");
});

