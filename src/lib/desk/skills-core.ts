// P8-③ 技能插件体系的纯内核：把「哪个场景自动派哪些工具、按什么形状给参」从 intent-core 的
// 硬编码 switch 里搬出来，变成一张可注册的数据表（任务书八-1：不写死调用顺序）。
//
// 三条口径：
//  1) 本层零运行时依赖（只 type-import intent-core，测试可直跑）；执行本体仍在 chat-tools
//     （服务层，带网络/prisma），两层靠 name 对齐 —— 名字漂了会被 execute 的
//     「调度计划里的工具未注册」如实接住，不会静默少取数。
//  2) 这是**声明式规则表**，不是模型判定：每条 entry 带 scene/spread/args/gate 判别符，
//     为什么取它、取几份都能一眼看出出处；注册新技能=往表里加一条，不用改调度代码。
//  3) 表驱动重构必须逐字保住既有编排（p7-intent 的 25 条调度断言是这轮的回归闸）：
//     per_symbol 项按「标的外层、技能内层」展开（个股分析三件套逐只成组，不是三个工具各扫一遍），
//     gate 不满足时静默不出 call，dedupe_snapshot 抵掉时留 skipped 原话。
import type { Scene } from "./intent-core.ts";

/** 入参形状判别符（具体拼法在 intent-core 的 planDispatch，文案单一出处） */
export type SkillArgs = "empty" | "news8" | "sector_kind" | "symbol" | "screener_pool" | "board_code" | "sector_name";
/** 「为什么取它」的文案键（渲染时套 SCENE_LABELS，与旧 switch 逐字一致；news 两变体照抄不统一） */
export type SkillReason = "scene" | "scene_snapshot" | "kline" | "fund_flow" | "depth" | "trades" | "news" | "news_why" | "watchlist" | "screener_pool" | "stock_news" | "sector_constituents" | "business_composition" | "sector_breadth";
/** 出条件判别符：news=提问显式要消息面；watchlist_nonempty=本机自选非空；board_code=提问里点了 BK 板块代码；chain=提问落在产业链/供应链类（白毛股神六问的触发口径）；industry_hit=提问命中了本地行业快照认得的行业名（服务层递进，纯层不查字典） */
export type SkillGate = "news" | "watchlist_nonempty" | "board_code" | "chain" | "industry_hit";

export interface SkillPlanEntry {
  scene: Scene;
  /** once=整轮一次；per_symbol=按识别到的标的逐个展开（同场景的 per_symbol 项逐只成组） */
  spread: "once" | "per_symbol";
  args: SkillArgs;
  reason: SkillReason;
  gate?: SkillGate;
  /** 客户端实时快照已带该品种就不重复取（只对 per_symbol 的快照类工具有意义） */
  dedupe_snapshot?: boolean;
  /** P8-④ 的输入：这一项没取到＝本轮必读数据有洞，触发一轮补充调用 */
  required?: boolean;
}

export interface Skill {
  /** 与 chat-tools 注册表同名的工具本体 */
  name: string;
  desc: string;
  /** 自动调度参与项（可多场景）；不给 = 只被模型自取，不被系统预取 */
  plan?: SkillPlanEntry[];
}

/** 场景级编排参数：标的上限、超限话术键、静态 skipped 话术键 */
export interface SceneDispatchConfig {
  /** 该场景 per_symbol 最多展开几个标的（省略＝全局 DISPATCH_MAX_SYMBOLS） */
  symbol_max?: number;
  /** 超限话术键（analysis=「个股分析一次最多看 N 只」原话） */
  cap?: "analysis";
  /** 整场景的静态留痕键（qimen/general 与「不预取」的原因；screener 自 P10 择优轮起预取候选池，不再跳过） */
  skip?: "qimen" | "general";
}

/** 全局一次对话最多预取几只（口径搬自 intent-core，导出名不变） */
export const DISPATCH_MAX_SYMBOLS = 5;
/** 个股分析最多预取几只（每只 5 个工具：快照/盘口/逐笔/日K/资金流 + 消息面，再深就慢得没法用） */
export const DISPATCH_ANALYSIS_MAX = 3;

// ---------- 内置技能表（顺序=chat-tools TOOLS 的注册顺序；换顺序会换调度顺序，别乱动） ----------

export const BUILTIN_SKILLS: Skill[] = [
  {
    name: "market_sentiment",
    desc: "大盘情绪：涨跌家数/涨停/跌停/成交额/主力净额/风险等级",
    plan: [{ scene: "sentiment", spread: "once", args: "empty", reason: "scene", required: true }],
  },
  {
    name: "sector_rank",
    desc: "行业/概念板块资金榜（按主力净流入排序）",
    plan: [{ scene: "sector", spread: "once", args: "sector_kind", reason: "scene", required: true }],
  },
  // Serenity 落点②（2026-09-29）：成分股只在「提问里点了 BK 板块代码」时预取——不点代码就无从知道取哪个板块，
  // 硬猜一个板块等于替用户决定看什么；没预取到也不影响：模型仍可先 sector_rank 拿 code 再自取。
  // 落点 A（2026-09-29）：东财断源、榜单退同花顺时，二阶段预取（chainFollowUpCalls）会改带**行业名**走本地
  // 行业归属快照备胎（data/sector-constituents.json）——这条不进本计划表（它是第二棒、由链研究档现算），
  // 所以这里的 gate 仍是 board_code：用户手打 BK 代码才走东财真成分。
  // 不标 required：板块代码可能存在但接口无返回，缺了留 missing，不触发补跑整轮。
  {
    name: "sector_constituents",
    desc: "板块成分股（真实名单；东财 BK 代码 或 行业名走本地行业归属快照）",
    plan: [{ scene: "sector", spread: "once", args: "board_code", reason: "sector_constituents", gate: "board_code" }],
  },
  // 2026-09-30（P35）：板块均线广度。推荐问题卡模板一直承诺「均线广度占比」但工具链里从来没有，
  // 模型只能写「暂无均线广度统计」（用户截图事故：半导体资金问答三处暂无数据）。
  // gate=industry_hit：只有提问命中本地行业快照认得的行业名才取（行业名由服务层递进，纯层不查字典）。
  {
    name: "sector_breadth",
    desc: "板块均线广度（成分股站上 MA5/MA10/MA20 占比，本地计算，非上游接口）",
    plan: [{ scene: "sector", spread: "once", args: "sector_name", reason: "sector_breadth", gate: "industry_hit" }],
  },
  {
    name: "stock_snapshot",
    desc: "个股实时快照：价格/涨跌幅/换手/量比/估值/主力净额/行业",
    plan: [
      { scene: "quote", spread: "per_symbol", args: "symbol", reason: "scene_snapshot", dedupe_snapshot: true, required: true },
      { scene: "stock_analysis", spread: "per_symbol", args: "symbol", reason: "scene_snapshot", dedupe_snapshot: true, required: true },
    ],
  },
  // stock_depth / stock_trades 进个股分析预取（P：用户实测「数据侧有五档，AI 分析里永远没有」——
  // 只把它放进模型自取清单是不够的，模型基本不会自己调，系统必须替它取到）。
  // 代价是每只多打两次 eltdx，所以两项都不标 required：网关没起就留 missing，不拖住这一轮。
  {
    name: "stock_depth",
    desc: "个股五档盘口（通达信网关）",
    plan: [{ scene: "stock_analysis", spread: "per_symbol", args: "symbol", reason: "depth" }],
  },
  {
    name: "stock_trades",
    desc: "个股主动买卖金额（内外盘全日口径，代理指标）",
    plan: [{ scene: "stock_analysis", spread: "per_symbol", args: "symbol", reason: "trades" }],
  },
  {
    name: "stock_kline_summary",
    desc: "个股技术状态：均线/MACD/KDJ/RSI/VWAP/RPS + 历史条件概率",
    plan: [{ scene: "stock_analysis", spread: "per_symbol", args: "symbol", reason: "kline", required: true }],
  },
  {
    name: "stock_fund_flow",
    desc: "个股近14日主力资金净额（东财）",
    plan: [{ scene: "stock_analysis", spread: "per_symbol", args: "symbol", reason: "fund_flow", required: true }],
  },
  // Serenity 落点②（2026-09-29）：只在「产业链/供应链/卡点/国产替代」这类问法上预取主营构成——
  // 六问第 3 步要的「卖什么、什么商业阶段」没有真披露就只能靠先验，这条是让纪律真取到数的唯一入口。
  // 为什么加 chain 闸而不是无条件逐只预取：上游是 china-stock-mcp 云调用（每只一次），
  // 普通「日K怎么看」根本用不到主营构成，无条件预取等于每轮多打 N 次云接口。
  // 不标 required：MCP 未配置/上游无返回留 missing 照样能答，不触发补跑。
  {
    name: "stock_business_composition",
    desc: "个股主营与产品构成（披露原文）",
    plan: [{ scene: "stock_analysis", spread: "per_symbol", args: "symbol", reason: "business_composition", gate: "chain" }],
  },
  {
    name: "market_news",
    desc: "最新宏观/市场快讯",
    plan: [
      { scene: "sentiment", spread: "once", args: "news8", reason: "news", gate: "news" },
      { scene: "stock_analysis", spread: "once", args: "news8", reason: "news_why", gate: "news" },
    ],
  },
  // R10 扩容（用户口径「除了技术还要结合新闻回答我」）：个股消息面进个股分析预取——
  // 教训是「只开放不自取」不够：R10 实测模型面对 tdx 清单一次都没自己调，
  // 该到的数据必须系统先替它到齐，缺了再让它补。逐只展开与快照/日K/资金流同组。
  {
    name: "stock_news",
    desc: "个股新闻与公告（东财搜索+披露列表），个股研判的必读消息面",
    plan: [{ scene: "stock_analysis", spread: "per_symbol", args: "symbol", reason: "stock_news", required: true }],
  },
  // factor_screener：P10 择优轮起进自动调度（用户裁定改口径，参考 aiwuchuan 的「候选池→择优」链路）。
  // P7 旧拍板「条件由模型抽、系统不替猜」拆成两半保住：抽得到的照抽（确定性正则），
  // 抽不到用默认活跃池但必须如实标注「系统默认口径」——把猜的条件当用户要求仍是事故。
  // historical_probability 维持不预取：那是逐只统计，池子出来后再由模型按需调用才有意义。
  {
    name: "factor_screener",
    desc: "全A条件选股：conditions=[{field,op,value}]，field 必须来自因子目录",
    plan: [{ scene: "screener", spread: "once", args: "screener_pool", reason: "screener_pool" }],
  },
  { name: "historical_probability", desc: "个股历史条件概率：conditions 中的 field 必须来自因子目录" },
  {
    name: "watchlist_overview",
    desc: "自选股实时总览（清单取自用户本机存档，行情现取）",
    plan: [{ scene: "watchlist", spread: "once", args: "empty", reason: "watchlist", gate: "watchlist_nonempty", required: true }],
  },
  { name: "run_backtest", desc: "因子组合历史回测（真实引擎计算），只由模型按需自调用，系统不预取" },
  // 奇门解盘是面板本地实算，对话链路不起局不取行情（plan 缺席 = 永不进自动调度）。
];

export const SCENE_DISPATCH_CONFIG: Record<Scene, SceneDispatchConfig> = {
  sentiment: {},
  sector: {},
  // P10：screener 不再整场景跳过（候选池预取见 factor_screener.plan）；skip 联合类型保留键位说明
  screener: {},
  quote: {},
  watchlist: {},
  stock_analysis: { symbol_max: DISPATCH_ANALYSIS_MAX, cap: "analysis" },
  qimen: { skip: "qimen" },
  general: { skip: "general" },
};

/** 场景到优先工具（不排他：模型仍可调注册表里任何一个）。表驱动前是 switch 里的数组，原样搬 */
export const SCENE_PREFERS: Record<Scene, string[]> = {
  sentiment: ["market_sentiment", "market_news"],
  sector: ["sector_rank", "market_sentiment"],
  screener: ["factor_screener", "historical_probability"],
  quote: ["stock_snapshot"],
  watchlist: ["watchlist_overview", "market_sentiment"],
  stock_analysis: ["stock_snapshot", "stock_depth", "stock_trades", "stock_kline_summary", "stock_fund_flow", "stock_news", "market_news"],
  qimen: [],
  general: [],
};

// ---------- 注册表（可注册 = 技能能被外部加进来，重名/缺描述会被如实拒绝） ----------

export interface SkillRegistry {
  skills(): Skill[];
  get(name: string): Skill | undefined;
  /** 注册新技能：名字必须没被占用且带 desc；成功 true，失败回原因（不静默覆盖内置） */
  register(skill: Skill): { ok: boolean; error?: string };
  /** 某场景的自动调度参与项（按注册顺序，per_symbol 项按注册相邻性成组） */
  entriesForScene(scene: Scene): { tool: string; entry: SkillPlanEntry }[];
  /** 某场景的必读工具集（P8-④ 完整性校验的输入） */
  requiredToolsForScene(scene: Scene): Set<string>;
  prefersForScene(scene: Scene): string[];
  configForScene(scene: Scene): SceneDispatchConfig;
}

export function createSkillRegistry(initial: Skill[] = [], config?: Partial<Record<Scene, SceneDispatchConfig>>, prefers?: Partial<Record<Scene, string[]>>): SkillRegistry {
  const map = new Map<string, Skill>();
  const cfg: Record<Scene, SceneDispatchConfig> = { ...SCENE_DISPATCH_CONFIG, ...config } as Record<Scene, SceneDispatchConfig>;
  const pref: Record<Scene, string[]> = { ...SCENE_PREFERS, ...prefers } as Record<Scene, string[]>;
  for (const s of initial) map.set(s.name, s);
  return {
    skills: () => [...map.values()],
    get: (name) => map.get(name),
    register(skill) {
      if (!skill?.name || typeof skill.name !== "string") return { ok: false, error: "技能名必须是非空字符串" };
      if (!skill.desc) return { ok: false, error: `技能 ${skill.name} 缺 desc：模型与界面都要能看出它是干什么的` };
      if (map.has(skill.name)) return { ok: false, error: `技能 ${skill.name} 已注册，不静默覆盖（要换实现请先摘旧的）` };
      for (const e of skill.plan ?? []) {
        if (!(e.scene in cfg)) return { ok: false, error: `技能 ${skill.name} 的 plan 指向不存在的场景 ${e.scene}` };
      }
      map.set(skill.name, skill);
      return { ok: true };
    },
    entriesForScene: (scene) =>
      [...map.values()].flatMap((s) => (s.plan ?? []).filter((e) => e.scene === scene).map((e) => ({ tool: s.name, entry: e }))),
    requiredToolsForScene: (scene) =>
      new Set([...map.values()].flatMap((s) => (s.plan ?? []).filter((e) => e.scene === scene && e.required).map(() => s.name))),
    prefersForScene: (scene) => pref[scene] ?? [],
    configForScene: (scene) => cfg[scene] ?? {},
  };
}

/** 进程内默认注册表：内置 13 项技能；registerSkill 是给扩展方（含测试）的唯一注入口 */
export const SKILLS = createSkillRegistry(BUILTIN_SKILLS);

export function registerSkill(skill: Skill): { ok: boolean; error?: string } {
  return SKILLS.register(skill);
}
