// MyDesk 个人行情工作台 - 共享类型

export type PageKey =
  | "aihome"       // 实时选股 · AI 对话首页（重定位后的一级入口）
  | "aiscan"       // AI 实时选股（全A扫描漏斗）
  | "pool"         // 候选池（冻结 + 次日验证）
  | "screener"     // 因子选股器
  | "profile"      // 个股资金画像
  | "market"       // 大盘情绪仪表盘
  | "sectors"      // 行业板块排行（P1-2）
  | "allstocks"    // 全A市场列表
  | "dashboard"    // 总览（旧）
  | "board"        // 数据看板
  | "analysis"     // AI 分析
  | "tracker"      // 追踪/自选
  | "history"      // 历史
  | "copilot"      // 智能助手
  | "quant"        // 量化研究实验室（Quant Research Lab，后台研究）
  | "factorlab"    // 因子有效性测试台（P1-4）
  | "extension"    // 扩展
  | "settings";    // 设置

export interface SectorRow {
  rank: number;
  name: string;       // 板块/股票名
  code: string;       // 板块代码（BKxxxx）或股票代码
  secid?: string;     // 真实数据源的东财 secid（如 90.BK1211 / 1.688256）
  changePct: number;  // 涨跌%
  main: number;       // 主力净额(亿)
  ratio: number;      // 占比%
  superBig: number;   // 超大单(亿)
  big: number;        // 大单(亿)
  leader: string;     // 板块=领涨股；个股=所属行业
}

export interface DetailDay {
  date: string;
  value: number;      // 主力净额(亿)
}

export interface SectorDetail {
  name: string;
  code: string;
  spark: number[];
  days: DetailDay[];
}

export interface QuoteCard {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  series: number[];
  prevClose?: number; // 昨收，用于绘制涨停/跌停线
  missing?: boolean;  // 真实数据源本次未取到（断源/停牌），界面显示"暂无数据"
}

export interface WatchItem {
  symbol: string;
  name: string;
  kind: "watch" | "hot";
}

export interface Candle {
  t: number;   // 序号
  o: number;
  h: number;
  l: number;
  c: number;
  date?: string; // 真实数据的日期（如 2026-09-18 10:30 或 2026-09-17）
}

export interface TrackerPlan {
  id: string;
  symbol: string;
  name: string;
  direction: "long" | "short";
  entry: number;
  stop: number;
  targets: number[];
  note: string;
  status: "watching" | "hit_stop" | "hit_target";
  createdAt: string;
}

export interface HistoryMeta {
  bias?: string;            // 看多 / 看空 / 震荡
  entry?: number;           // 入场参考价
  stop?: number;
  targets?: number[];
  risk?: string;            // 风险提示原文
  trend?: string;           // 该周期趋势（上行/下行/震荡）
  rsi?: number | null;
  rangeHigh?: number | null;
  rangeLow?: number | null;
  rangePos?: number | null; // 区间位置 0-100
}

export interface HistoryEntry {
  id: string;
  symbol: string;
  name: string;
  style: string;
  timeframe: string;
  summary: string;
  createdAt: string;
  meta?: HistoryMeta;       // 旧存档无此字段，详情页按缺省展示
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  trusted: boolean;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description?: string;
}

// ---- AI 接口设置（只保存在本机浏览器；Key 不落盘、不进服务端日志） ----
export type AiProvider =
  | "openai" | "anthropic" | "gemini"
  | "deepseek" | "moonshot" | "openrouter" | "ollama" | "custom";

export interface AiSettings {
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  proxy?: string; // 出网代理：留空=自动（环境变量/系统代理）；direct=强制直连；或填 http://127.0.0.1:端口
}

export const PAGE_TITLES: Record<PageKey, string> = {
  aihome: "实时选股 · AI 首页",
  aiscan: "AI 实时选股",
  pool: "候选池",
  screener: "因子选股器",
  profile: "个股资金画像",
  market: "大盘情绪",
  sectors: "行业板块排行",
  allstocks: "全A市场列表",
  dashboard: "总览",
  board: "数据看板",
  analysis: "AI 分析",
  tracker: "自选股",
  history: "历史",
  copilot: "智能助手",
  quant: "量化研究",
  factorlab: "因子测试台",
  extension: "扩展",
  settings: "设置",
};
