// P15-R15 显示层「人话核」：把只有工程侧才认识的记号（英文状态枚举、打分表版本号、
// 引擎文件名、上游接口名）在**渲染那一刻**翻译成中文读法。
//
// 为什么单独一层（以及为什么只做显示层）：
// - 数据与判定层必须继续说英文枚举（LIVE/DEGRADED/p7.decision.v3…），那是血缘与钉测的锚点；
//   用户在页面上看到的应该是人话。两头都要，就得有一层专门负责「换读法不换判定」。
// - 本层只做**读法映射**：不许改数值、不许改判定、不许吞状态——每个函数都保留原文可回溯的出口
//   （认不出的记号原样透传，绝不猜、绝不编一个好看的中文）。
// - decision-core 等不动清单里的文件产出的字符串（版本号、文件名），全部在这里收口。
// 零依赖纯核：node --test 可直跑，钉在 p15-r15-plain-ui.test.ts。

/** 徽章位（独立小胶囊）的完整中文读法：认不出的枚举原样返回，绝不翻译成错的 */
export const STATUS_ZH: Record<string, string> = {
  LIVE: "实时",
  REAL: "真实数据",
  DERIVED: "派生计算",
  HISTORICAL: "历史留档",
  SNAPSHOT: "留档快照",
  AI_INTERPRETATION: "AI 解释",
  AI_HYPOTHESIS: "AI 假设",
  AI_NOT_CONFIGURED: "模型未配置",
  AI_FAILED: "模型通道失败",
  NO_EVIDENCE: "没取到台账",
  NO_EVENTS: "当日没有事件",
  ACCEPTED: "结论成立",
  PARTIAL: "部分完成",
  REJECTED: "不可用",
  INTERPRETED: "已完成解释",
  MISSING: "未取到",
  DEGRADED: "已降级",
  ARCHIVED: "留档",
  DEMO: "演示数据",
  OFFLINE: "已离线",
  HISTORICAL_EVIDENCE: "历史证据",
  UNVERIFIED: "未验证",
  VERIFIED: "已验证",
  DERIVED_ON_DEMO: "演示数据派生",
};

/** 行内小字位（分项后面跟着的那种）的短读法 */
export const STATUS_SHORT_ZH: Record<string, string> = {
  LIVE: "实时",
  REAL: "真实",
  DERIVED: "派生",
  HISTORICAL: "历史",
  SNAPSHOT: "留档",
  AI_INTERPRETATION: "AI解释",
  AI_HYPOTHESIS: "AI假设",
  AI_NOT_CONFIGURED: "模型未配置",
  AI_FAILED: "模型失败",
  NO_EVIDENCE: "没台账",
  NO_EVENTS: "没事件",
  ACCEPTED: "成立",
  PARTIAL: "部分",
  REJECTED: "不可用",
  INTERPRETED: "已解释",
  MISSING: "缺读数",
  DEGRADED: "降级",
  ARCHIVED: "留档",
  DEMO: "演示",
  OFFLINE: "离线",
  HISTORICAL_EVIDENCE: "历史证据",
  UNVERIFIED: "未验证",
  VERIFIED: "已验证",
  DERIVED_ON_DEMO: "演示派生",
};

/**
 * 徽章文案：`REAL 已取到` 这类「英文头 + 中文尾」的串只留中文尾（尾本来就说明白了）；
 * 光杆英文枚举翻成 STATUS_ZH；认不出的（含中文开头、带小写）原样透传。
 * 颜色判定不受影响——调用方拿 raw 做正则，这里只管读法。
 */
export function statusZh(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  const m = /^([A-Z][A-Z_]+)(?:\s+(.*))?$/.exec(s);
  if (!m) return s;
  const rest = (m[2] ?? "").trim();
  const zh = STATUS_ZH[m[1]];
  if (!zh) return s;
  return rest ? rest : zh;
}

/** 行内短读法：把串里出现的整词英文枚举逐个换短（如 `DERIVED` → `派生`）；认不出的原样 */
export function statusShortZh(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return s;
  return s.replace(/\b(AI_INTERPRETATION|AI_HYPOTHESIS|AI_NOT_CONFIGURED|AI_FAILED|NO_EVIDENCE|NO_EVENTS|ACCEPTED|PARTIAL|REJECTED|INTERPRETED|HISTORICAL_EVIDENCE|HISTORICAL|SNAPSHOT|DEGRADED|ARCHIVED|DERIVED_ON_DEMO|DERIVED|MISSING|OFFLINE|LIVE|REAL|DEMO|UNVERIFIED|VERIFIED)\b/g,
    (tok) => STATUS_SHORT_ZH[tok] ?? tok);
}

const DIM_ZH: Record<string, string> = { technical: "技术面", probability: "概率面", market: "市场面", event: "事件面" };

/**
 * 版本号的人话读法：p7.s7.technical.v1 ⇒「技术面打分表 第1版」，p7.taskbook.s6 ⇒「任务书§6 打分表」，
 * p7.decision.v3 ⇒「四维决策口径 第3版」，p7.s7.wiring.v1 ⇒「接线口径 第1版」。
 * 认不出的版本串原样返回（宁可露一个旧记号，也不翻出一个错名字）。
 */
export function verZh(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  if (!s) return "";
  let m = /^p7\.s7\.(technical|probability|market|event)\.v(\d+)$/.exec(s);
  if (m) return `${DIM_ZH[m[1]]}打分表 第${m[2]}版`;
  m = /^p7\.s3\.(technical|probability|market|event)\.v(\d+)$/.exec(s);
  if (m) return `旧${DIM_ZH[m[1]]}打分表 第${m[2]}版`;
  m = /^p7\.taskbook\.s(\d+)$/.exec(s);
  if (m) return `任务书§${m[1]} 打分表`;
  m = /^p7\.decision\.v(\d+)$/.exec(s);
  if (m) return `四维决策口径 第${m[1]}版`;
  m = /^p7\.s7\.wiring\.v(\d+)$/.exec(s);
  if (m) return `接线口径 第${m[1]}版`;
  return s;
}

/** 只要尾号（胶囊位太窄时用）：…v3 ⇒ 第3版，…s6 ⇒ §6；认不出原样 */
export function verTail(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  const m = /\.v(\d+)$/.exec(s) ?? /s(\d+)$/.exec(s);
  if (!m) return s;
  return /\.v\d+$/.test(s) ? `第${m[1]}版` : `§${m[1]}`;
}

/**
 * 整句清洗：先把串里整词的英文状态枚举换成短读法（statusShortZh 同一张表），再把
 * decision-core 等不动清单产出的正文里夹带的引擎文件名/表名/版本号换成人话读法。
 * 只认列出的记号形态，其余字符一个都不动（原句可 diff 回去）；判定与数据不经此处。
 */
export function plainify(text: string | null | undefined): string {
  if (!text) return text ?? "";
  return statusShortZh(text)
    .replace(/probability\.ts（historicalWinProbability）/g, "历史胜率统计引擎")
    .replace(/similar-env\.ts（similarReturnForward）/g, "相似历史日统计引擎")
    // 留档表名的行文写法（页面只说「哪份留档」；payload/JSON 字段里的表名不经过这里，照旧保留）。
    .replace(/\bevent_interpretation 表/g, "事件解释留档")
    .replace(/\bresearch_report 表/g, "研究留档")
    .replace(/\bfactor_test 表/g, "因子验证留档")
    // 引擎函数名与字段名（能力登记表 limitations 里的写法）：只换页面上的读法。
    .replace(/fetchBarsHybridTracked 的 outcomes\/degraded/g, "双通道取数引擎的逐只结果与降级标记")
    .replace(/dropped\.probability_claims/g, "「被剔除记录」")
    .replace(/\bNOT IMPLEMENTED\b/g, "尚未实现")
    // 能力登记表/工具集口径串（registryBasis / agentToolBasis）：钉测验的是纯函数原文，这里只换页面上的读法。
    .replace(/mutating=true 的能力/g, "会改数据的能力")
    .replace(/\bmutating=true\b/g, "标了「会改数据」")
    .replace(/\bprobed:false\b/g, "未探测")
    .replace(/同一次探测返回的 kind/g, "同一次探测返回的观测结果")
    .replace(/每次调用的 kind\/as_of\/scope\/reason/g, "每次调用的观测结果／时刻／探测范围／原因")
    // 雷达历史行的来源推导串（radarSourceOf 被 p4 钉在纯函数原文上，页面渲染时换读法）。
    .replace(/\bcomputeSentiment\b/g, "情绪引擎现算")
    .replace(/\bdiscoverThemes\b/g, "主线发现引擎")
    .replace(/kind=risk\/anomaly/g, "类型=风险/异动")
    .replace(/\bkind=(theme|fund|news|risk|anomaly)\b/g, (_all, k: string) => `类型=${({ theme: "主线", fund: "资金", news: "消息", risk: "风险", anomaly: "异动" } as Record<string, string>)[k]}`)
    .replace(/\bkind=/g, "类型=")
    // 新鲜度徽标/说明（freshnessChip/freshnessNote 被 p6 钉在纯函数原文上，含「daily 口径」这类词）：只换读法。
    .replace(/\b(live|intraday|daily|static)\s*(?=口径)/g, (_all, l: string) =>
      ({ live: "实时", intraday: "盘中", daily: "当日", static: "静态" } as Record<string, string>)[l])
    .replace(/\bp7\.s7\.wiring\.v(\d+)\b/g, "接线口径 第$1版")
    .replace(/\bp7\.s7\.(technical|probability|market|event)\.v(\d+)\b/g, (_all, d: string, n: string) => `${DIM_ZH[d]}打分表 第${n}版`)
    .replace(/\bp7\.s3\.(technical|probability|market|event)\.v(\d+)\b/g, (_all, d: string, n: string) => `旧${DIM_ZH[d]}打分表 第${n}版`)
    .replace(/\bp7\.taskbook\.s(\d+)\b/g, "任务书§$1 打分表")
    .replace(/\bp7\.decision\.v(\d+)\b/g, "四维决策口径 第$1版");
}

/** 提示词/协议内部编号的人话读法（p6c-1 ⇒「研究提示词 第1版」）；认不出原样，不猜 */
export function promptVerZh(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  let m = /^p6c-(\d+)$/.exec(s);
  if (m) return `研究提示词 第${m[1]}版`;
  m = /^p6b-(\d+)$/.exec(s);
  if (m) return `事件解释提示词 第${m[1]}版`;
  m = /^p6d-(\d+)$/.exec(s);
  if (m) return `自主分析提示词 第${m[1]}版`;
  m = /^p6d\.agent\.v(\d+)$/.exec(s);
  if (m) return `自主分析协议 第${m[1]}版`;
  return s;
}

/** MCP 服务器运行态的中文化（设置页胶囊）：认不出的状态原样，不猜 */
export function mcpStatusZh(status: string | null | undefined): string {
  switch (status) {
    case "ready": return "已就绪";
    case "starting": return "启动中";
    case "failed": return "启动失败";
    case "stopped": return "未启动";
    default: return status ?? "未启动";
  }
}
