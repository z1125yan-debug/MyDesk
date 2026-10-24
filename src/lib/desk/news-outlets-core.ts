// 新闻筛选：催化分流器规则版 v1（2026-10-24）。
// 只做分类展示，不接选股、不进 AI 优选、不写库、不改任何生产数据。
// 口径说明（与 2026-10-24 下午定的分流器方案一致，规则先行、拿不准不硬塞）：
// - 9 个口子 = 主题 6（政策制度/突发事件/产品技术/行业数据/机构观点/负面风险）
//   + 个股 3（订单中标/业绩预告/公司事件）；匹配不到任何口子的归「未分类」，不强行归类。
// - 优先级即判定顺序：负面风险 > 澄清否认（直接未分类）> 订单中标 > 业绩预告
//   > 突发事件 > 政策制度 > 行业数据 > 产品技术 > 机构观点 > 公司事件。
// - 关键词会漏是已知局限（例：花旗获批标题不在「证券公司/券商+设立」模式里）：
//   v1 只保证「分进去的基本是对的」，不保证「全分进去」；漏网的先落在未分类里，
//   后续再上语义分类（模型判 + 置信度）时补。

export type NewsOutletKey =
  | "policy"
  | "incident"
  | "product"
  | "data"
  | "institution"
  | "risk"
  | "order"
  | "earnings"
  | "company"
  | "unclassified";

export interface NewsOutletDef {
  key: NewsOutletKey;
  label: string;
  desc: string;
}

export const NEWS_OUTLETS: NewsOutletDef[] = [
  { key: "policy", label: "政策制度", desc: "政府发文、组建机构、规划补贴：只改叙事、不直接给订单" },
  { key: "incident", label: "突发事件", desc: "漏洞、攻击、演训、冲突：需求最直接、爆发最快" },
  { key: "product", label: "产品技术", desc: "新品发布、技术突破：常是主题点火器" },
  { key: "data", label: "行业数据", desc: "产量、销量、订单数据超预期：给叙事上硬数字" },
  { key: "institution", label: "机构观点", desc: "大行研报、机构表态：只放大已有主题，防旧闻翻炒" },
  { key: "risk", label: "负面风险", desc: "双开、立案、警示、爆雷：触发规避，不进买入线" },
  { key: "order", label: "订单中标", desc: "个股新订单：金额 + 动作词双条件，MLF/保供等排除" },
  { key: "earnings", label: "业绩预告", desc: "预增、扭亏、预计净利：最容易证伪，看位置" },
  { key: "company", label: "公司事件", desc: "重组、收购、合作、定增、回购：须带关联个股" },
  { key: "unclassified", label: "未分类", desc: "规则没命中的先放这里，不硬塞进任何口子" },
];

export const NEWS_OUTLET_LABEL: Record<NewsOutletKey, string> = Object.fromEntries(
  NEWS_OUTLETS.map((o) => [o.key, o.label]),
) as Record<NewsOutletKey, string>;

export interface ClassifyResult {
  outlet: NewsOutletKey;
  /** 命中的规则词（展示用，如「中标＋金额」「双开」）；未分类时为空 */
  rule: string;
}

/** 找第一个命中的词，返回它本身（展示用）；都没命中返回空 */
function hit(text: string, words: string[]): string {
  for (const w of words) {
    if (text.includes(w)) return w;
  }
  return "";
}

const AMOUNT_RE = /(\d+(?:\.\d+)?)\s*(亿|万)\s*元/;
const ORDER_ACTION = ["中标", "签约", "签订", "签署", "获得订单", "拿下订单"];
const ORDER_EXCLUDE = ["MLF", "央行", "国债", "地方债", "能源保供", "在手订单充足", "在手订单饱满", "生产经营正常", "经营情况正常"];
const EARNINGS_WORDS = ["业绩预告", "预计净利", "预计净利润", "预增", "预减", "扭亏", "首亏", "续亏", "预计亏损"];
// 「预计2026年前三季度净利润同比增长98%-110%」这种：预计和净利润之间隔着报告期，
// 固定词组 includes 命中不了，必须用跨词正则（例：长川科技 10-21 预增，之前就这么漏过一次）。
const EARNINGS_RE = /预计[^，,。]{0,25}(净利润|净利|亏损)|净利润[^，,。]{0,20}同比增长|扣非[^，,。]{0,20}同比增长/;
const RISK_WORDS = ["双开", "立案调查", "被立案", "留置", "被查", "监管警示", "警示函", "行政处罚", "证监会立案", "爆雷", "接管", "跑路", "退市风险", "重大违法", "纪委监委"];
const DENIAL_WORDS = ["澄清", "否认", "尚无", "不实", "传闻不属实", "与事实不符"];
const INCIDENT_WORDS = ["漏洞", "CVE", "RCE", "攻击", "黑客", "入侵", "演训", "军演", "冲突", "爆炸", "地震", "制裁", "断供"];
const POLICY_WORDS = ["国务院", "发改委", "工信部", "国资委", "国家数据局", "政治局", "印发", "规划纲要", "若干意见", "实施意见", "管理办法", "条例", "组建", "成立大会", "国家数据集团"];
const DATA_SUBJECTS = ["产量", "销量", "出货量", "装机量", "订单额", "开工率", "产能利用率"];
const DATA_SUFFIX = ["同比", "环比", "增长", "超预期", "创新高"];
const PRODUCT_WORDS = ["新品发布", "发布会", "首发", "技术突破", "问世"];
const PRODUCT_PHRASES = ["大模型", "模型", "芯片", "机器人", "新品", "系统"];
const INSTITUTION_WORDS = ["研报", "分析师", "高盛", "摩根士丹利", "摩根大通", "中信证券", "首席"];
const INSTITUTION_VIEWS = ["机构", "券商"];
const COMPANY_WORDS = ["重组", "收购", "战略合作", "合作", "定增", "回购", "增持", "设立子公司", "投资项目"];

/**
 * 规则版分类。只看标题（财联社标题是编辑写的主旨句，信号最干净）：
 * 正文匹配会把「晚间精选」「近期经营情况」这类汇总稿里顺带提到的旧订单、新合同也算进来，
 * 实测漏进订单口子的全是这种（中际旭创在手订单饱满、润建股份业务占比、阳光股份服务费上调）。
 * 标题为空时才退回正文前 120 字（正文开头的【】里往往就是标题）。
 * stockCount = 电报 stock_list 里的个股数（公司事件口子要求 > 0）。
 */
export function classifyNews(title: string, content: string, stockCount: number): ClassifyResult {
  const t = (title || "").trim();
  const text = t ? t : (content || "").slice(0, 120);

  const risk = hit(text, RISK_WORDS);
  if (risk) return { outlet: "risk", rule: risk };

  // 澄清/否认类：不进任何口子（例：太极股份「与国家数据集团尚无具体合作」不能算政策制度；
  // 「在手订单充足、生产经营正常」类澄清公告不能算订单中标）。
  if (hit(text, DENIAL_WORDS)) return { outlet: "unclassified", rule: "" };

  // 订单中标：动作词 + 金额双条件；命中排除词时直接放过（MLF、保供、发债都不是个股订单）。
  if (hit(text, ORDER_ACTION) && AMOUNT_RE.test(text) && !hit(text, ORDER_EXCLUDE)) {
    return { outlet: "order", rule: "中标/签约＋金额" };
  }

  const earnings = hit(text, EARNINGS_WORDS);
  if (earnings) return { outlet: "earnings", rule: earnings };
  if (EARNINGS_RE.test(text)) return { outlet: "earnings", rule: "预计＋净利润/亏损" };

  const incident = hit(text, INCIDENT_WORDS);
  if (incident) return { outlet: "incident", rule: incident };

  const policy = hit(text, POLICY_WORDS);
  if (policy) return { outlet: "policy", rule: policy };

  if (hit(text, DATA_SUBJECTS) && hit(text, DATA_SUFFIX)) {
    return { outlet: "data", rule: "行业数据＋同比/增长" };
  }

  const product = hit(text, PRODUCT_WORDS);
  if (product) return { outlet: "product", rule: product };
  if (text.includes("发布") && hit(text, PRODUCT_PHRASES)) {
    return { outlet: "product", rule: "发布＋产品" };
  }

  const institution = hit(text, INSTITUTION_WORDS);
  if (institution) return { outlet: "institution", rule: institution };
  if (text.includes("认为") && hit(text, INSTITUTION_VIEWS)) {
    return { outlet: "institution", rule: "机构/券商观点" };
  }

  if (stockCount > 0) {
    const company = hit(text, COMPANY_WORDS);
    if (company) return { outlet: "company", rule: company };
  }

  return { outlet: "unclassified", rule: "" };
}
