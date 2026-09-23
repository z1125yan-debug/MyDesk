// P15-R17 钉测：看板「资金去向」跟榜单同拍刷新 + 涨幅时刻说人话（R17a），
// 以及原来只能手动刷的那几页接上全站轮询（R17b）。
// 一把尺子沿用 R7/R8/R16：口径行为钉在纯函数上，接线钉在源码形状上，node --test 直跑零 IO。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------- R17a：资金去向图的口径跟着榜单走 ----------

test("BubbleFlow 单位跟着看板 tab 走：行业/概念/地域榜不许再谎称「个股」", () => {
  const src = read("src/components/desk/BubbleFlow.tsx");
  assert.match(src, /unitLabel: string;/, "单位由父组件传入，是 props 不是内部常量");
  assert.match(src, /红 = 主力净流入\{unitLabel\}（资金流入） \/ 绿 = 主力净流出\{unitLabel\}（资金流出）/, "图内说明按单位写，红绿各说清资金在进还是在出");
  assert.equal(/流入个股|流出个股/.test(src), false, "写死「个股」的两处文案必须清零：板块榜上就是口径错");
  assert.match(src, /\{unitLabel\}榜 · 前 \{TOP\} 名/, "列头标出这是哪种榜的前几名");
  assert.match(src, /流入 \/ 流出 \{unitLabel\}数（榜内）/, "汇总卡的家数口径也跟着单位走");
  assert.match(src, /主力净流入合计（流入榜前 \{ins\.length\} 名\{unitLabel\}）/, "合计只算图里画出来的前 N 名，不冒充全市场合计");
});

test("资金去向图里每行直接摆当日涨幅：不悬停也能看出是不是今天的涨，取不到显「—」不显 NaN", () => {
  const src = read("src/components/desk/BubbleFlow.tsx");
  assert.match(src, /const X_PCT = 466;/, "涨幅有自己的列位，跟净额条不重叠");
  assert.match(src, /textAnchor="end" fontFamily="ui-monospace, monospace"/, "涨幅右对齐，跟名称列不打架");
  assert.match(src, /fill=\{Number\.isFinite\(row\.changePct\)/, "NaN 走中性样式，不给假红假绿");
  assert.match(src, /row\.changePct\.toFixed\(2\)\}%`[\s\S]{0,30}: "—"/, "有读数才画百分号，没读数是一个「—」");
  assert.match(src, /row\.name\.length > 7 \? `\$\{row\.name\.slice\(0, 7\)\}…`/, "名称过长截断给涨幅让位，全名在悬停与上方榜单里");
  assert.match(src, /当日涨幅 <span/, "悬停明细里也写「当日涨幅」，不留在无上下文的「涨跌」");
  assert.match(src, /tip\.mainSelfComputed && <span className="ml-2 text-\[10px\] text-amber-300">自算<\/span>/, "自算行悬停也带自算标记，出身不只在表头");
});

test("空态说人话：没读数就讲清楚不画流向，不拿占位 0 编线宽", () => {
  const src = read("src/components/desk/BubbleFlow.tsx");
  assert.match(src, /资金流向暂无读数：\{unitLabel\}榜里/, "空态带单位，读者知道是哪张榜空");
  assert.match(src, /不拿占位 0 画流向、不编造线宽/, "缺数不补 0 的纪律在图上也成立");
});

test("看板把单位、同步口径与双时刻一起交给资金去向卡", () => {
  const page = read("src/components/desk/pages/BoardPage.tsx");
  assert.match(page, /const unit = kind === "stock" \? "个股" : "板块";/, "单位由当前 tab 决定");
  assert.match(page, /unitLabel=\{unit\}/, "单位真的传进图里，不是只在父组件自己用");
  assert.match(page, /与上方榜单同步：每 \$\{poll\.interval\}s 换一批（第 \$\{poll\.tick\} 轮）/, "开盘：写明跟榜单同拍、周期几秒、第几轮");
  assert.match(page, /A股\$\{poll\.sessionLabel\}，自动刷新已暂停——画面停在最后一次取到的时刻/, "休市：明说暂停并停在最后一次取到的时刻");
  assert.match(page, /· 数据截至 \{asOfStamp\}[\s\S]*· 行情时刻 \{quoteTime\}/, "卡上自带本机取数时刻与行情侧时刻两个戳，各答各的事");
  assert.match(page, /涨幅为当日（\{asOfStamp\.slice\(0, 5\)\}）盘中读数/, "页头直接回答「这是哪天的涨幅」");
  assert.match(page, /<th className="px-2 py-2\.5 text-right font-normal">当日涨幅%<\/th>/, "列头从「涨跌%」改口为「当日涨幅%」");
  assert.match(page, /资金去向 · 主力净额前 8 名\{unit\}/, "卡片标题用用户口中的「资金去向」");
  assert.equal(/红 = 主力净流入个股/.test(page), false, "父组件里那份写死「个股」的说明同步改口");
});

test("轮询钩子把刷新周期一并交出来：页面要写「每 Ns 同步」不必各自再去 store 读一遍", () => {
  const hook = read("src/hooks/use-live-poll.ts");
  assert.match(hook, /interval: number;/, "LivePoll 契约里有周期");
  assert.match(hook, /sessionLabel: session\.label, interval \}/, "返回值把周期带出去");
});

// ---------- R17b：原来只能手动刷的页接上活体刷新 ----------

test("总览页扔掉自带的 setInterval 与 render 期写 ref：换成共用钩子 + 取数完成时刻", () => {
  const page = read("src/components/desk/pages/OverviewPage.tsx");
  assert.equal(/setInterval\(/.test(page), false, "本页不再有第二套计时器");
  assert.equal(/openRef/.test(page), false, "render 期写 ref 的老写法一并清掉（那是 lint 债）");
  assert.match(page, /\[watchKey, poll\.tick\]/, "自选卡片跟着全站轮询重取");
  assert.match(page, /setFetchedAt\(r\.cards\.some\(\(c\) => !c\.missing\) \? new Date\(\)\.toISOString\(\) : ""\)/, "一张真报价都没取到就不给时刻，LiveStamp 显「本次未取到数据」");
  assert.match(page, /<LiveStamp poll=\{poll\} iso=\{fetchedAt\} \/>/, "时刻上屏");
  assert.match(page, /涨跌幅为当日/, "卡片区域说明这是当日涨跌");
  assert.match(page, /演示品种 · 不是实时行情/, "演示品种卡片自己认领「不是实时行情」，不混在真数里");
  assert.match(page, /演示数据（非实时行情）/, "整页出身文案把「演示」读起来就是假的这层意思挑明");
});

test("主线发现两页接轮询：轮询失败只报不清空，手动「立即重算」失败才清空", () => {
  for (const f of [
    "src/components/desk/pages/ThemesPage.tsx",
    "src/components/desk/pages/ThemeOverviewPage.tsx",
  ]) {
    const src = read(f);
    assert.match(src, /const poll = useLivePoll\(\);/, `${f} 必须接钩子`);
    assert.match(src, /\[load, poll\.tick\]/, `${f} 的取数要跟着轮次重跑`);
    assert.match(src, /if \(force\) setData\(null\);/, `${f}：轮询那一拍失败保留上一批真实读数（旧数标旧时），只有手动重算失败才清空`);
    assert.match(src, /<LiveStamp poll=\{poll\} iso=\{data\?\.as_of \?\? ""\} \/>/, `${f} 把服务端 as_of 时刻摆上屏`);
    assert.match(src, /当日涨幅/, `${f} 的涨幅口径写明是当日`);
    assert.match(src, /立即重算/, `${f}：按钮说的是「绕开缓存重算」这件事，跟自动刷新区分开`);
  }
  const ov = read("src/components/desk/pages/ThemeOverviewPage.tsx");
  assert.match(ov, /画面停在上一批真实读数上（截至 \{data\.as_of\.slice\(11, 19\)\}）/, "血缘总览报错时讲清屏上是什么时候的数");
});

test("量化门户的现价探测不轮询，但必须写明是何时探的、并自称一口价", () => {
  const page = read("src/components/desk/QuantPage.tsx");
  assert.match(page, /setUniverseAsOf\(new Date\(\)\.toISOString\(\)\)/, "探测成功就记下时刻");
  assert.match(page, /现价＝\{clockZh\(universeAsOf\)/, "表上写明现价属于哪一刻");
  assert.match(page, /探测时刻未记录（本轮没记上，别当实时价读）/, "记不上时刻就直说，不装作是实时");
  assert.match(page, /本表不自动刷/, "为什么不接轮询写在页面上：拉整个股票池，按 30 秒打是白烧上游");
  assert.match(page, /现价（探测时一口价）/, "列头不再光写「现价」");
});
