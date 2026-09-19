// Quant Screener — 因子字段目录与计算引擎（纯逻辑，可被 node:test 直跑）
// 数据纪律：
//  1) snapshot 类字段只有当日快照口径（无历史时点数据），只参与当日筛选，
//     不参与历史条件概率匹配（引擎会明确剔除并提示）。
//  2) kline 类字段由日线 OHLCV/成交额逐日计算，历史每一天都有值，可做历史匹配。
//  3) 所有字段初始均未经 IC/稳定性测试 → verified:false。
//     （文档五：未通过测试的因子必须标记，不得假装已验证。）
//     P1-4 因子测试台通过后经 markFieldVerified() 落盘（data/factor-verified.json），
//     factorCatalog() 读取该文件（mtime 缓存）把对应字段覆盖为 verified:true；
//     文件缺失/损坏时安全回退全部未验证。

import fs from "node:fs";
import path from "node:path";

export type FactorFieldSource = "kline" | "snapshot";

export type FactorFieldCategoryZh =
  | "估值与市值"
  | "量能与活跃度"
  | "趋势与均线"
  | "动量与形态"
  | "主力资金与成本"
  | "VWAP体系"
  | "支撑阻力"
  | "缠论"
  | "TD序列"
  | "江恩"
  | "高斯通道"
  | "庄家宝体系"
  | "板块与概念"
  | "共振与竞价";

export interface FactorFieldDef {
  key: string;
  zh: string;
  category: FactorFieldCategoryZh;
  source: FactorFieldSource;
  /** 初始 false；因子测试台通过后由落盘状态覆盖（见 factorCatalog） */
  verified: boolean;
  /** 数值单位提示（仅展示用） */
  unit?: string;
  /** §七 注册要求：原始公式说明 */
  description?: string;
  /** 通达信原始公式原文（任务书口径：不得自行优化/改参数） */
  formula?: string;
  /** 因子血缘（依赖的其他因子 key / 计算中间量） */
  dependencies?: string[];
  /** 数据依赖说明（如「仅日线 OHLCV」/「需 WINNER/COST 筹码分布」） */
  data_requirements?: string;
  /** 默认 true；false=已登记但本轮不计算（不删除定义），status 说明原因 */
  implemented?: boolean;
  status?: "pending_dependency";
  /** RSI_V / BDW 的 N 值原始资料未明确：默认值仅为参数化占位，未经确认 */
  param_n_pending?: boolean;
}

export const FACTOR_FIELD_DEFS: FactorFieldDef[] = [
  // 估值与市值（快照）
  { key: "pe_ttm", zh: "市盈率TTM", category: "估值与市值", source: "snapshot", verified: false },
  { key: "pb", zh: "市净率", category: "估值与市值", source: "snapshot", verified: false },
  { key: "market_cap_yi", zh: "总市值(亿)", category: "估值与市值", source: "snapshot", verified: false, unit: "亿元" },
  { key: "floatcap_yi", zh: "流通市值(亿)", category: "估值与市值", source: "snapshot", verified: false, unit: "亿元" },
  // 量能与活跃度
  { key: "change_pct", zh: "涨跌幅", category: "量能与活跃度", source: "snapshot", verified: false, unit: "%" },
  { key: "turnover_rate", zh: "换手率", category: "量能与活跃度", source: "snapshot", verified: false, unit: "%" },
  { key: "volume_ratio", zh: "量比", category: "量能与活跃度", source: "snapshot", verified: false },
  { key: "amplitude", zh: "振幅", category: "量能与活跃度", source: "snapshot", verified: false, unit: "%" },
  { key: "amount_yi", zh: "成交额(亿)", category: "量能与活跃度", source: "snapshot", verified: false, unit: "亿元" },
  { key: "is_limit_up", zh: "今日涨停", category: "量能与活跃度", source: "kline", verified: false },
  { key: "double_volume_signal", zh: "倍量信号", category: "量能与活跃度", source: "kline", verified: false },
  { key: "volume_signal", zh: "量能信号", category: "量能与活跃度", source: "kline", verified: false },
  // 趋势与均线
  { key: "above_ma_5", zh: "站上MA5", category: "趋势与均线", source: "kline", verified: false },
  { key: "above_ma_10", zh: "站上MA10", category: "趋势与均线", source: "kline", verified: false },
  { key: "above_ma_20", zh: "站上MA20", category: "趋势与均线", source: "kline", verified: false },
  { key: "above_ma_60", zh: "站上MA60", category: "趋势与均线", source: "kline", verified: false },
  { key: "above_ma_90", zh: "站上MA90", category: "趋势与均线", source: "kline", verified: false },
  { key: "above_ma_144", zh: "站上MA144", category: "趋势与均线", source: "kline", verified: false },
  { key: "ma_struct", zh: "均线多头排列", category: "趋势与均线", source: "kline", verified: false },
  { key: "ema14_gt_ema26", zh: "EMA14>EMA26", category: "趋势与均线", source: "kline", verified: false },
  { key: "rps_50", zh: "RPS50", category: "趋势与均线", source: "kline", verified: false },
  { key: "rps_120", zh: "RPS120", category: "趋势与均线", source: "kline", verified: false },
  { key: "rps_composite", zh: "RPS综合", category: "趋势与均线", source: "kline", verified: false },
  // 动量与形态
  { key: "macd_dif", zh: "MACD DIF", category: "动量与形态", source: "kline", verified: false },
  { key: "macd_dea", zh: "MACD DEA", category: "动量与形态", source: "kline", verified: false },
  { key: "macd", zh: "MACD柱", category: "动量与形态", source: "kline", verified: false },
  { key: "macd_cross", zh: "MACD金叉", category: "动量与形态", source: "kline", verified: false },
  { key: "kdj_k", zh: "KDJ K", category: "动量与形态", source: "kline", verified: false },
  { key: "kdj_d", zh: "KDJ D", category: "动量与形态", source: "kline", verified: false },
  { key: "kdj_j", zh: "KDJ J", category: "动量与形态", source: "kline", verified: false },
  { key: "kdj_cross", zh: "KDJ金叉", category: "动量与形态", source: "kline", verified: false },
  { key: "rsi_7", zh: "RSI7", category: "动量与形态", source: "kline", verified: false },
  { key: "rsi_14", zh: "RSI14", category: "动量与形态", source: "kline", verified: false },
  { key: "rsi_24", zh: "RSI24", category: "动量与形态", source: "kline", verified: false },
  { key: "atr_ratio_14", zh: "相对波动率", category: "动量与形态", source: "kline", verified: false, unit: "%" },
  { key: "upper_shadow_ratio", zh: "长上影(上影/实体)", category: "动量与形态", source: "kline", verified: false },
  { key: "lower_shadow_ratio", zh: "长下影(下影/实体)", category: "动量与形态", source: "kline", verified: false },
  // 主力资金与成本
  { key: "main_net_yi", zh: "主力净额(东财)", category: "主力资金与成本", source: "snapshot", verified: false, unit: "亿元" },
  { key: "above_cost_20", zh: "站上20日成本线", category: "主力资金与成本", source: "kline", verified: false },
  { key: "break_cost_20", zh: "突破20日成本线", category: "主力资金与成本", source: "kline", verified: false },
  // VWAP体系
  { key: "vwap20_filter", zh: "站上VWAP20", category: "VWAP体系", source: "kline", verified: false },
  { key: "vwap_pos", zh: "VWAP位置(偏离%)", category: "VWAP体系", source: "kline", verified: false, unit: "%" },
  { key: "vwap20_up3", zh: "VWAP20上行", category: "VWAP体系", source: "kline", verified: false },
  // 支撑阻力（近端高低点近似，非通达信趋势线公式）
  { key: "breakout_high_20", zh: "突破20日高点", category: "支撑阻力", source: "kline", verified: false },
  { key: "breakout_high_60", zh: "突破60日高点", category: "支撑阻力", source: "kline", verified: false },
  // 支撑阻力信号（P0补齐·任务C：支撑/阻力线=滚动N日低/高（不含当日））
  { key: "support_near_60", zh: "贴近60日支撑", category: "支撑阻力", source: "kline", verified: false },
  { key: "support_near_144", zh: "贴近144日支撑", category: "支撑阻力", source: "kline", verified: false },
  { key: "support_bounce_60", zh: "60日支撑反抽", category: "支撑阻力", source: "kline", verified: false },
  { key: "support_bounce_144", zh: "144日支撑反抽", category: "支撑阻力", source: "kline", verified: false },
  { key: "resistance_breakout_60", zh: "60日阻力突破", category: "支撑阻力", source: "kline", verified: false },
  { key: "resistance_breakout_144", zh: "144日阻力突破", category: "支撑阻力", source: "kline", verified: false },
  // 缠论（简化口径见 fields.ts 内公式注释，待测试台验证）
  { key: "chan_top_fractal", zh: "缠论顶分型", category: "缠论", source: "kline", verified: false },
  { key: "chan_bottom_fractal", zh: "缠论底分型", category: "缠论", source: "kline", verified: false },
  { key: "chan_third_buy", zh: "缠论三买(简化)", category: "缠论", source: "kline", verified: false },
  { key: "chan_third_sell", zh: "缠论三卖(简化)", category: "缠论", source: "kline", verified: false },
  { key: "cz_break_up", zh: "中枢上破", category: "缠论", source: "kline", verified: false },
  { key: "cz_break_down", zh: "中枢下破", category: "缠论", source: "kline", verified: false },
  // TD序列（Tom DeMark Setup9 + Countdown13，简化口径见注释）
  { key: "td_buy_seq", zh: "TD买入计数", category: "TD序列", source: "kline", verified: false, unit: "根" },
  { key: "td_sell_seq", zh: "TD卖出计数", category: "TD序列", source: "kline", verified: false, unit: "根" },
  { key: "td_signal", zh: "TD9完成信号", category: "TD序列", source: "kline", verified: false },
  { key: "td13_buy_qualified", zh: "TD13买入合格", category: "TD序列", source: "kline", verified: false },
  { key: "td13_sell_qualified", zh: "TD13卖出合格", category: "TD序列", source: "kline", verified: false },
  // 江恩（时方格简化：以120日摆动低点为基准，价格斜率=基数×比例/交易日）
  { key: "gann_support_sig_1_1", zh: "江恩1x1支撑信号", category: "江恩", source: "kline", verified: false },
  { key: "gann_support_sig_1_2", zh: "江恩1x2支撑信号", category: "江恩", source: "kline", verified: false },
  { key: "gann_support_sig_2_1", zh: "江恩2x1支撑信号", category: "江恩", source: "kline", verified: false },
  // 高斯通道（零滞后高斯加权均线 ± 倍数×加权标准差）
  { key: "gauss_mid", zh: "高斯中轨", category: "高斯通道", source: "kline", verified: false, unit: "元" },
  { key: "gauss_upper", zh: "高斯上轨", category: "高斯通道", source: "kline", verified: false, unit: "元" },
  { key: "gauss_lower", zh: "高斯下轨", category: "高斯通道", source: "kline", verified: false, unit: "元" },
  { key: "gauss_trend_up", zh: "高斯趋势上行", category: "高斯通道", source: "kline", verified: false },
  { key: "gauss_trend_flip_up", zh: "高斯上翻", category: "高斯通道", source: "kline", verified: false },
  { key: "gauss_trend_flip_down", zh: "高斯下翻", category: "高斯通道", source: "kline", verified: false },
  { key: "gauss_overheat", zh: "高斯通道过热", category: "高斯通道", source: "kline", verified: false },
  // VWAP体系补全（必须有成交额K线；无量额 → null 宁缺勿假）
  { key: "vwap20", zh: "VWAP20(成本价)", category: "VWAP体系", source: "kline", verified: false, unit: "元" },
  { key: "vwap20_slope3", zh: "VWAP20三日上斜%", category: "VWAP体系", source: "kline", verified: false, unit: "%" },
  { key: "vwap_score", zh: "VWAP综合分", category: "VWAP体系", source: "kline", verified: false, unit: "0-3" },
  { key: "allow_long", zh: "VWAP允许做多", category: "VWAP体系", source: "kline", verified: false },
  { key: "entry_signal", zh: "VWAP入场信号", category: "VWAP体系", source: "kline", verified: false },
  // ---- 庄家宝体系（zsb）：稳智AI前端字段 + 通达信原始公式（2026-09-19 用户提供公式原文）----
  // 口径纪律（任务书§6.1/§6.2）：严格按原始通达信公式实现，不自行"优化"、不改参数；
  // SMA(X,N,M) 是递归加权平均（≠简单移动平均）；「控盘」为纯价格中间量（≠需筹码分布的「高度控盘」）。
  {
    key: "zsb_dealer", zh: "庄家线", category: "庄家宝体系", source: "kline", verified: false,
    description: "81日RSV的KDJ-J值再6日EMA，范围约0~100；>=50 仅为前端业务筛选阈值，因子值保留原始数值",
    formula: "RSV:=(CLOSE-LLV(LOW,81))/(HHV(HIGH,81)-LLV(LOW,81))*100; K:=SMA(RSV,3,1); D:=SMA(K,3,1); J:=3*K-2*D; 庄家:=EMA(J,6);",
    dependencies: ["kdjCalc(RSV81→K/D/J)", "ema(J,6)"],
    data_requirements: "仅日线 OHLCV（复用 kdjCalc 的 SMA 递归，窗口参数 81）",
  },
  {
    key: "zsb_retail", zh: "散户线", category: "庄家宝体系", source: "kline", verified: false,
    description: "34日区间内的相对位置（越高越贴近高点）；M=34 固定不改；数值不解释为「恐慌」等情绪标签",
    formula: "M:=34; 散户:=100*(HHV(HIGH,34)-CLOSE)/(HHV(HIGH,34)-LLV(LOW,34));",
    dependencies: ["HHV(H,34)", "LLV(L,34)"],
    data_requirements: "仅日线 OHLCV",
  },
  {
    key: "zsb_rsi_v", zh: "资金RSI(RSI_V)", category: "庄家宝体系", source: "kline", verified: false,
    description: "成交量口径的通达信SMA递归RSI；N 原始资料未明确，默认14为参数化占位（param_n_pending）",
    formula: "LC:=REF(VOL,1); RSI_V:=SMA(MAX(VOL-LC,0),N,1)/SMA(ABS(VOL-LC),N,1)*100;",
    dependencies: ["VOL"],
    data_requirements: "仅日线成交量；N=14 默认值待确认",
    param_n_pending: true,
  },
  {
    key: "acc_dif", zh: "吸筹DIF", category: "庄家宝体系", source: "kline", verified: false,
    description: "与项目现有 macdCalc 的 DIF 同口径（EMA12-EMA26），一致故直接复用同一序列",
    formula: "DIF:=EMA(CLOSE,12)-EMA(CLOSE,26);",
    dependencies: ["ema(C,12)", "ema(C,26)"],
    data_requirements: "仅日线收盘价",
  },
  {
    key: "acc_dea", zh: "吸筹DEA", category: "庄家宝体系", source: "kline", verified: false,
    description: "与项目现有 macdCalc 的 DEA 同口径，复用",
    formula: "DEA:=EMA(DIF,9);",
    dependencies: ["acc_dif"],
    data_requirements: "仅日线收盘价",
  },
  {
    key: "acc_macd", zh: "吸筹MACD柱", category: "庄家宝体系", source: "kline", verified: false,
    description: "与项目现有 macdCalc 柱口径一致（2*(DIF-DEA)），复用同一序列",
    formula: "MACD:=2*(DIF-DEA);",
    dependencies: ["acc_dif", "acc_dea"],
    data_requirements: "仅日线收盘价",
  },
  {
    key: "zsb_rsi_reduce", zh: "量仓信号(RSI_V超买回落)", category: "庄家宝体系", source: "kline", verified: false,
    description: "0/1 信号：资金RSI≥80 且较前一日回落",
    formula: "量仓信号:=IF(RSI_V>=80 AND RSI_V<REF(RSI_V,1),1,0);",
    dependencies: ["zsb_rsi_v"],
    data_requirements: "仅日线成交量",
  },
  {
    key: "zsb_accum", zh: "吸筹信号", category: "庄家宝体系", source: "kline", verified: false,
    description: "0/1 信号：MACD柱由≤0转正 且 纯价格控盘>0（不依赖 WINNER/COST 筹码分布）",
    formula: "VAR1:=EMA(EMA(CLOSE,9),9); 控盘:=(VAR1-REF(VAR1,1))/REF(VAR1,1)*1000; 吸筹:=IF(MACD>0 AND REF(MACD,1)<=0 AND 控盘>0,1,0);",
    dependencies: ["acc_macd", "控盘(纯价格中间量)"],
    data_requirements: "仅日线 OHLCV",
  },
  {
    key: "zsb_attack", zh: "攻击力", category: "庄家宝体系", source: "kline", verified: false,
    description: "0/1 信号：资金RSI≥50 且 庄家>散户 且 纯价格控盘>0（不依赖筹码分布）",
    formula: "攻击力:=IF(RSI_V>=50 AND 庄家>散户 AND 控盘>0,1,0);",
    dependencies: ["zsb_rsi_v", "zsb_dealer", "zsb_retail", "控盘(纯价格中间量)"],
    data_requirements: "仅日线 OHLCV",
  },
  {
    key: "zsb_trigger", zh: "触发", category: "庄家宝体系", source: "kline", verified: false,
    description: "0/1 信号：金叉(庄家上穿散户) 且 吸筹=1 且 放量(VOL>MA(VOL,5))",
    formula: "触发:=IF(CROSS(庄家,散户) AND 吸筹=1 AND VOL>MA(VOL,5),1,0);",
    dependencies: ["zsb_dealer", "zsb_retail", "zsb_accum", "VOL/MA(VOL,5)"],
    data_requirements: "仅日线 OHLCV",
  },
  {
    key: "zsb_bdw", zh: "波段位(BDW)", category: "庄家宝体系", source: "kline", verified: false,
    description: "N日价格变化率×量×100；N 原始资料未明确，默认20为参数化占位（param_n_pending），不声称已准确复刻",
    formula: "BDW:=(CLOSE-REF(CLOSE,N))/REF(CLOSE,N)*VOL*100;",
    dependencies: ["CLOSE", "VOL"],
    data_requirements: "仅日线 OHLCV；N=20 默认值待确认",
    param_n_pending: true,
  },
  // ---- 已登记但本轮不实现（无数据依赖满足 / 无原始公式），不删除定义 ----
  {
    key: "zsb_height_control", zh: "高度控盘", category: "庄家宝体系", source: "kline", verified: false,
    description: "依赖通达信 WINNER()/COST() 筹码分布函数，当前仅日线 OHLCV 无筹码数据 → 不计算；禁止用三角分布模型近似冒充",
    formula: "VAR2:=100*WINNER(CLOSE*0.95); 高度控盘:=IF(VAR2>50 AND COST(85)<CLOSE AND 控盘>0,控盘,0);",
    dependencies: ["WINNER()", "COST()", "控盘(纯价格中间量)"],
    data_requirements: "需筹码分布数据（本项目无）",
    implemented: false, status: "pending_dependency",
  },
  {
    key: "acc_base", zh: "基础吸筹", category: "庄家宝体系", source: "kline", verified: false,
    description: "稳智AI前端存在该字段但无原始公式定义 → 不猜测、不实现",
    data_requirements: "需通达信公式原文",
    implemented: false, status: "pending_dependency",
  },
  {
    key: "strong_acc_conds_met", zh: "强势吸筹_满足条件数", category: "庄家宝体系", source: "kline", verified: false,
    description: "无原始公式定义 → 不猜测、不实现",
    data_requirements: "需通达信公式原文",
    implemented: false, status: "pending_dependency",
  },
  {
    key: "strong_acc_pick", zh: "强势吸筹选股", category: "庄家宝体系", source: "kline", verified: false,
    description: "无原始公式定义 → 不猜测、不实现",
    data_requirements: "需通达信公式原文",
    implemented: false, status: "pending_dependency",
  },
  // ---- P2 剩余因子包（任务书 2026-09-19）：A组纯日线可算因子 ----
  // 口径纪律：任务书 A4 部分行按字面直译会产生恒真/恒假（如 C<LLV(L,250) 含当日时恒假），
  // 凡「线」参与信号比较处，统一采用本项目支撑/压力线标准口径 = REF(LLV/HHV(N),1)（不含当日），
  // 与既有 support_bounce_60 等一致；纯线值字段（*_line_250 / *_144_val）按任务书字面 LLV/HHV（含当日）。
  // 每条公式注释即口径，禁止事后凭结果改口径。
  // A1 VWAP体系（vwap_pos/vwap_score 已存在且口径一致，不重复注册）
  {
    key: "vwap30", zh: "VWAP30(成本价)", category: "VWAP体系", source: "kline", verified: false, unit: "元",
    description: "30日累计成交额/累计成交量；无量额K线整段 null（宁缺勿假，与 vwap20 同口径）",
    formula: "VWAP30:=SUM(AMOUNT,30)/SUM(VOL,30);", dependencies: ["amount", "vol"],
    data_requirements: "需成交额K线（eltdx 有；腾讯日K无 amount → null）",
  },
  {
    key: "vwap_full", zh: "VWAP全周期", category: "VWAP体系", source: "kline", verified: false, unit: "元",
    description: "SUM(AMOUNT,0)/SUM(VOL,0)：自样本首日起累计（对有效量额日累计；全程无量额 → null）",
    formula: "VWAP_FULL:=SUM(AMOUNT,0)/SUM(VOL,0);", dependencies: ["amount", "vol"],
    data_requirements: "需成交额K线",
  },
  {
    key: "vwap_slope3", zh: "全周期VWAP三日斜率%", category: "VWAP体系", source: "kline", verified: false, unit: "%",
    description: "基于 vwap_full（vwap20 口径已有独立字段 vwap20_slope3，二者不混用）",
    formula: "slope3:=(VWAP_FULL-REF(VWAP_FULL,3))/REF(VWAP_FULL,3)*100;", dependencies: ["vwap_full"],
    data_requirements: "需成交额K线",
  },
  {
    key: "vwap_slope6", zh: "全周期VWAP六日斜率%", category: "VWAP体系", source: "kline", verified: false, unit: "%",
    formula: "slope6:=(VWAP_FULL-REF(VWAP_FULL,6))/REF(VWAP_FULL,6)*100;", dependencies: ["vwap_full"],
    data_requirements: "需成交额K线",
  },
  {
    key: "vwap_accel", zh: "VWAP加速度", category: "VWAP体系", source: "kline", verified: false, unit: "%",
    description: "斜率的变化率；REF(slope3,3)≈0 时不可判 → null（不伪造）",
    formula: "accel:=(slope3-REF(slope3,3))/REF(slope3,3)*100;", dependencies: ["vwap_slope3"],
    data_requirements: "需成交额K线",
  },
  {
    key: "vwap_lowpullback", zh: "VWAP低吸回踩", category: "VWAP体系", source: "kline", verified: false,
    description: "VWAP 锚定本项目主成本线 vwap20（任务书未指明锚，选择口径已在摘要披露）；放量基准 MA(VOL,20)",
    formula: "C<REF(VWAP20,1) AND C>VWAP20 AND VOL>MA(VOL,20);", dependencies: ["vwap20", "vol"],
    data_requirements: "需成交额K线（vwap20 依赖）",
  },
  {
    key: "vwap_break_expand", zh: "VWAP突破放量", category: "VWAP体系", source: "kline", verified: false,
    description: "VWAP 锚定 vwap20；放量倍数 1.5 为任务书固定参数",
    formula: "C>REF(VWAP20,1) AND VOL>MA(VOL,20)*1.5;", dependencies: ["vwap20", "vol"],
    data_requirements: "需成交额K线",
  },
  // A2 高斯通道（既有 gauss_overheat=收盘>上轨，与 gauss_overheat_warn=触上轨+放量 是两个不同定义）
  {
    key: "gauss_entry", zh: "高斯入场(上穿中轨)", category: "高斯通道", source: "kline", verified: false,
    formula: "CROSS(CLOSE, 高斯中轨);  // 中轨=gaussChannel.mid（零滞后高斯加权均线，win=40）",
    dependencies: ["gauss_mid"], data_requirements: "仅日线收盘价",
  },
  {
    key: "gauss_exit", zh: "高斯出场(下穿中轨)", category: "高斯通道", source: "kline", verified: false,
    formula: "CROSS(高斯中轨, CLOSE);  // 中轨上穿收盘 = 收盘下穿中轨",
    dependencies: ["gauss_mid"], data_requirements: "仅日线收盘价",
  },
  {
    key: "gauss_overheat_warn", zh: "高斯过热预警(触上轨+放量)", category: "高斯通道", source: "kline", verified: false,
    formula: "CLOSE>=高斯上轨 AND VOL>MA(VOL,20)*1.5;",
    dependencies: ["gauss_upper", "vol"], data_requirements: "仅日线 OHLCV",
  },
  // A3 缠论简化中枢（任务书口径：最近10日 HHV(H,10)/LLV(L,10)，含当日；不做严格分型笔段递归）
  {
    key: "cz_active", zh: "中枢激活(收盘在10日区间内)", category: "缠论", source: "kline", verified: false,
    formula: "CLOSE>=LLV(LOW,10) AND CLOSE<=HHV(HIGH,10);",
    dependencies: ["HHV(H,10)", "LLV(L,10)"], data_requirements: "仅日线 OHLC",
  },
  {
    key: "cz_start", zh: "中枢形成(首次进入区间)", category: "缠论", source: "kline", verified: false,
    formula: "今日在区间内 AND 昨日不在区间内（昨日按昨日窗口判定）;",
    dependencies: ["cz_active"], data_requirements: "仅日线 OHLC",
  },
  {
    key: "cz_end", zh: "中枢结束(突破区间)", category: "缠论", source: "kline", verified: false,
    formula: "今日 CLOSE>HHV(HIGH,10) OR CLOSE<LLV(LOW,10) 的当日（即脱离区间日）且昨日在区间内;",
    dependencies: ["cz_active"], data_requirements: "仅日线 OHLC",
  },
  {
    key: "cz_inside", zh: "中枢内震荡收窄", category: "缠论", source: "kline", verified: false,
    description: "区间内 且 区间宽度较昨日收窄（振幅收窄）",
    formula: "在区间内 AND (HHV(H,10)-LLV(L,10)) < REF(HHV(H,10)-LLV(L,10),1);",
    dependencies: ["cz_active"], data_requirements: "仅日线 OHLC",
  },
  // A4 支撑压力 250/144 变体（12个）
  {
    key: "support_line_250", zh: "250日支撑线", category: "支撑阻力", source: "kline", verified: false, unit: "元",
    formula: "LLV(LOW,250);  // 任务书字面：含当日", dependencies: ["L"], data_requirements: "仅日线最低价；需≥250根K线" },
  {
    key: "resistance_line_250", zh: "250日压力线", category: "支撑阻力", source: "kline", verified: false, unit: "元",
    formula: "HHV(HIGH,250);  // 含当日", dependencies: ["H"], data_requirements: "仅日线最高价；需≥250根K线" },
  {
    key: "support_bounce_250", zh: "250支撑反弹", category: "支撑阻力", source: "kline", verified: false,
    description: "线=REF(LLV(LOW,250),1)（不含当日，项目标准口径）",
    formula: "LOW<=线*1.02 AND CLOSE>REF(CLOSE,1);", dependencies: ["support_line(不含当日)"],
    data_requirements: "仅日线 OHLC；需≥250根K线" },
  {
    key: "resistance_rebound_250", zh: "250压力回落", category: "支撑阻力", source: "kline", verified: false,
    description: "线=REF(HHV(HIGH,250),1)",
    formula: "HIGH>=线*0.98 AND CLOSE<REF(CLOSE,1);", dependencies: ["resistance_line(不含当日)"],
    data_requirements: "仅日线 OHLC；需≥250根K线" },
  {
    key: "support_break_250", zh: "跌破250支撑", category: "支撑阻力", source: "kline", verified: false,
    description: "线=REF(LLV(LOW,250),1)；跌破须发生「上→下」穿越事件（任务书第二项 REF(C,1)>=REF(LLV,1) 的等价口径）",
    formula: "CLOSE<线 AND REF(CLOSE,1)>=REF(线,1);", dependencies: ["support_line(不含当日)"],
    data_requirements: "仅日线 OHLC；需≥250根K线" },
  {
    key: "resistance_breakout_250", zh: "突破250压力", category: "支撑阻力", source: "kline", verified: false,
    description: "线=REF(HHV(HIGH,250),1)；任务书无穿越事件要求，按字面直用比较",
    formula: "CLOSE>线 AND VOL>MA(VOL,20)*1.5;", dependencies: ["resistance_line(不含当日)", "VOL"],
    data_requirements: "仅日线 OHLCV；需≥250根K线" },
  {
    key: "support_near_250", zh: "接近250支撑", category: "支撑阻力", source: "kline", verified: false,
    description: "任务书 (LLV-C)/C<0.03 字面会恒真（C 通常高于支撑），采用项目 support_near 同构口径：收于线上且距离<3%",
    formula: "CLOSE>=线 AND (CLOSE-线)/线*100<3;  // 线=REF(LLV(LOW,250),1)",
    dependencies: ["support_line(不含当日)"], data_requirements: "仅日线 OHLC；需≥250根K线" },
  {
    key: "resistance_near_250", zh: "接近250压力", category: "支撑阻力", source: "kline", verified: false,
    description: "与 support_near_250 镜像：收于线下且距离<3%",
    formula: "CLOSE<=线 AND (线-CLOSE)/线*100<3;  // 线=REF(HHV(HIGH,250),1)",
    dependencies: ["resistance_line(不含当日)"], data_requirements: "仅日线 OHLC；需≥250根K线" },
  {
    key: "support_breakdown_250", zh: "250支撑破位确认", category: "支撑阻力", source: "kline", verified: false,
    description: "连续2日收在250支撑下方（线逐日按不含当日口径）",
    formula: "CLOSE<线(t) AND REF(CLOSE,1)<线(t-1);", dependencies: ["support_line(不含当日)"],
    data_requirements: "仅日线 OHLC；需≥250根K线" },
  {
    key: "resistance_breakout_250_conf", zh: "250压力突破确认", category: "支撑阻力", source: "kline", verified: false,
    description: "连续2日收在250压力上方",
    formula: "CLOSE>线(t) AND REF(CLOSE,1)>线(t-1);", dependencies: ["resistance_line(不含当日)"],
    data_requirements: "仅日线 OHLC；需≥250根K线" },
  {
    key: "support_144_val", zh: "144日支撑线值", category: "支撑阻力", source: "kline", verified: false, unit: "元",
    formula: "LLV(LOW,144);  // 任务书字面：含当日", dependencies: ["L"], data_requirements: "仅日线最低价" },
  {
    key: "resistance_144_val", zh: "144日压力线值", category: "支撑阻力", source: "kline", verified: false, unit: "元",
    formula: "HHV(HIGH,144);  // 含当日", dependencies: ["H"], data_requirements: "仅日线最高价" },
  // A5 其他
  {
    key: "market_cost_60", zh: "60日市场成本", category: "主力资金与成本", source: "kline", verified: false, unit: "元",
    description: "与 market_cost_20(=vwap20) 同口径：累计成交额/累计成交量（任务书 SUM(C*V,60) 为等价简写，本项目统一用真实成交额，无量额→null）",
    formula: "SUM(AMOUNT,60)/SUM(VOL,60);", dependencies: ["amount", "vol"],
    data_requirements: "需成交额K线",
  },
  {
    key: "vol_spike_ratio", zh: "成交量脉冲", category: "量能与活跃度", source: "kline", verified: false,
    formula: "VOL/MA(VOL,20);", dependencies: ["VOL"], data_requirements: "仅日线成交量",
  },
  {
    key: "close_dev_ma120", zh: "偏离120日线%", category: "趋势与均线", source: "kline", verified: false, unit: "%",
    formula: "(CLOSE-MA(CLOSE,120))/MA(CLOSE,120)*100;", dependencies: ["MA(C,120)"],
    data_requirements: "仅日线收盘价",
  },
  {
    key: "amplitude_20d", zh: "20日振幅", category: "量能与活跃度", source: "kline", verified: false, unit: "%",
    formula: "(HHV(HIGH,20)-LLV(LOW,20))/LLV(LOW,20)*100;  // 含当日",
    dependencies: ["H", "L"], data_requirements: "仅日线 OHLC",
  },
  // ---- B组受限 pending（只注册不实现，摘要见 factorCatalog；UI 显示「未实现」）----
  {
    key: "candle_patterns_text", zh: "K线形态文本", category: "动量与形态", source: "kline", verified: false,
    description: "识别：大阳/大阴/十字星/锤头/吞没，输出字符串标签。纯函数 candlePatternCalc 已实现并有单测；" +
      "但当前因子面板/IC框架仅支持数值列，字符串字段需架构支持后接入筛选（不做数字编码假接入）",
    formula: "LABEL: 大阳(收阳且涨幅≥3%)/大阴(镜像)/十字星(实体≤10%×振幅)/锤头(下影≥2×实体且上影≤0.5×实体)/看涨吞没/看跌吞没；优先级：吞没>大阳阴>十字星>锤头",
    data_requirements: "仅日线 OHLC；需面板字符串列支持",
    implemented: false, status: "pending_dependency",
  },
  {
    key: "pe_dynamic", zh: "市盈率-动态", category: "估值与市值", source: "snapshot", verified: false,
    description: "CLOSE/EPS_动态；数据源仅提供 pe_ttm，无动态EPS字段 → 不猜测、不实现",
    formula: "PE_DYNAMIC:=CLOSE/EPS_DYNAMIC;", data_requirements: "需 EPS 数据（当前源无）",
    implemented: false, status: "pending_dependency",
  },
  {
    key: "sector_rps_50", zh: "板块RPS50", category: "板块与概念", source: "kline", verified: false,
    description: "需板块指数行情聚合（板块页有涨幅榜，但无逐日板块RPS历史序列）→ 待接入，不造数",
    data_requirements: "板块指数行情", implemented: false, status: "pending_dependency",
  },
  {
    key: "sector_rps_120", zh: "板块RPS120", category: "板块与概念", source: "kline", verified: false,
    description: "同 sector_rps_50：需逐日板块指数历史，不造数",
    data_requirements: "板块指数行情", implemented: false, status: "pending_dependency",
  },
  {
    key: "in_sector_rps_50", zh: "个股在板块RPS50", category: "板块与概念", source: "kline", verified: false,
    description: "需板块成分映射+板块内逐日排名，当前无该历史数据 → 不实现",
    data_requirements: "板块成分映射", implemented: false, status: "pending_dependency",
  },
  {
    key: "in_sector_rps_120", zh: "个股在板块RPS120", category: "板块与概念", source: "kline", verified: false,
    description: "同 in_sector_rps_50：需板块成分映射历史数据",
    data_requirements: "板块成分映射", implemented: false, status: "pending_dependency",
  },
  {
    key: "concept_rps_50", zh: "概念RPS50", category: "板块与概念", source: "kline", verified: false,
    description: "需概念指数历史+成分映射 → 数据缺，不实现",
    data_requirements: "概念指数+成分", implemented: false, status: "pending_dependency",
  },
  {
    key: "concept_rps_120", zh: "概念RPS120", category: "板块与概念", source: "kline", verified: false,
    description: "同 concept_rps_50",
    data_requirements: "概念指数+成分", implemented: false, status: "pending_dependency",
  },
  {
    key: "concept_lead_strength", zh: "概念领涨强度", category: "板块与概念", source: "kline", verified: false,
    description: "需概念成分映射+逐日聚合，数据缺 → 不实现",
    data_requirements: "概念成分映射", implemented: false, status: "pending_dependency",
  },
  {
    key: "bidding_reversal_signal", zh: "竞价弱转强信号", category: "共振与竞价", source: "snapshot", verified: false,
    description: "需集合竞价分钟/逐笔数据，当前日线+快照体系无该数据 → 不实现",
    data_requirements: "集合竞价分钟数据", implemented: false, status: "pending_dependency",
  },
  {
    key: "bidding_reversal_score", zh: "竞价转强评分", category: "共振与竞价", source: "snapshot", verified: false,
    description: "同 bidding_reversal_signal：需集合竞价数据，当前源无",
    data_requirements: "集合竞价分钟数据", implemented: false, status: "pending_dependency",
  },
  {
    key: "bidding_volume_ratio", zh: "竞价量比", category: "共振与竞价", source: "snapshot", verified: false,
    description: "需竞价逐笔/分时数据，当前日线+快照体系无 → 不实现",
    data_requirements: "竞价逐笔数据", implemented: false, status: "pending_dependency",
  },
  {
    key: "bidding_premium_score", zh: "竞价溢价评分", category: "共振与竞价", source: "snapshot", verified: false,
    description: "需竞价逐笔数据；且无公式原文 → 双重缺失，不猜测",
    data_requirements: "竞价逐笔数据", implemented: false, status: "pending_dependency",
  },
  {
    key: "super_resonance_week", zh: "周线共振", category: "共振与竞价", source: "kline", verified: false,
    description: "需周线跨周期数据（日线重采样可行但公式原文未提供，不猜测参数）",
    data_requirements: "周线跨周期数据+公式原文", implemented: false, status: "pending_dependency",
  },
  {
    key: "zsb_super_buy", zh: "庄家宝超级买入", category: "庄家宝体系", source: "kline", verified: false,
    description: "竞价+筹码复合条件，两类依赖数据均缺 → 不实现、不近似",
    data_requirements: "竞价数据+筹码分布", implemented: false, status: "pending_dependency",
  },
];

export const FACTOR_FIELD_MAP: Map<string, FactorFieldDef> = new Map(FACTOR_FIELD_DEFS.map((f) => [f.key, f]));

export const FACTOR_FIELD_CATEGORIES: FactorFieldCategoryZh[] = [
  "估值与市值", "量能与活跃度", "趋势与均线", "动量与形态", "主力资金与成本", "VWAP体系", "支撑阻力",
  "缠论", "TD序列", "江恩", "高斯通道", "庄家宝体系", "板块与概念", "共振与竞价",
];

export function factorCatalog(): {
  fields: FactorFieldDef[];
  category: Record<string, string[]>;
} {
  const overrides = loadVerifiedOverrides();
  const category: Record<string, string[]> = {};
  const fields = FACTOR_FIELD_DEFS.map((f) => {
    // 已登记但未实现（implemented=false）：保留在 fields（注册要求），不进 category 可选清单
    if (f.implemented !== false) (category[f.category] ??= []).push(f.key);
    return overrides[f.key] ? { ...f, verified: true } : f;
  });
  return { fields, category };
}

// ---- P1-4：因子测试通过的 verified 状态（落盘 JSON，跨模块实例/重启一致） ----

const VERIFIED_FILE = path.join(process.cwd(), "data", "factor-verified.json");
let verifiedCache: { mtimeMs: number; map: Record<string, boolean> } | null = null;

function loadVerifiedOverrides(): Record<string, boolean> {
  try {
    const st = fs.statSync(VERIFIED_FILE);
    if (!verifiedCache || verifiedCache.mtimeMs !== st.mtimeMs) {
      const raw = JSON.parse(fs.readFileSync(VERIFIED_FILE, "utf8")) as Record<string, boolean>;
      verifiedCache = { mtimeMs: st.mtimeMs, map: raw && typeof raw === "object" ? raw : {} };
    }
    return verifiedCache.map;
  } catch {
    verifiedCache = null;
    return {};
  }
}

/** 记录某因子的验证结论（写盘 + 供 factorCatalog 读取） */
export function markFieldVerified(key: string, verified: boolean): void {
  const map = { ...loadVerifiedOverrides() };
  if (verified) map[key] = true; else delete map[key];
  try {
    fs.mkdirSync(path.dirname(VERIFIED_FILE), { recursive: true });
    fs.writeFileSync(VERIFIED_FILE, JSON.stringify(map, null, 2), "utf8");
    verifiedCache = null; // 使本实例缓存失效，下次读盘
  } catch {
    // 写盘失败不影响测试结果返回（下次 catalog 仍显示旧状态）
  }
}

// ---------- 技术指标（单序列，null 安全） ----------

type Series = (number | null)[];

export function sma(x: Series, n: number): Series {
  const out: Series = new Array(x.length).fill(null);
  let sum = 0, cnt = 0;
  for (let t = 0; t < x.length; t++) {
    const v = x[t];
    if (v !== null) { sum += v; cnt++; }
    if (t >= n) {
      const old = x[t - n];
      if (old !== null) { sum -= old; cnt--; }
    }
    if (cnt >= Math.ceil(n * 0.8) && t >= n - 1) out[t] = sum / cnt;
  }
  return out;
}

export function ema(x: Series, n: number): Series {
  const out: Series = new Array(x.length).fill(null);
  const k = 2 / (n + 1);
  let prev: number | null = null;
  for (let t = 0; t < x.length; t++) {
    const v = x[t];
    if (v === null) { out[t] = prev; continue; }
    prev = prev === null ? v : v * k + prev * (1 - k);
    out[t] = prev;
  }
  return out;
}

export function macdCalc(c: Series): { dif: Series; dea: Series; bar: Series } {
  const dif = sub(ema(c, 12), ema(c, 26));
  const dea = ema(dif, 9);
  const bar = sub(scalarMul(dif, 2), scalarMul(dea, 2));
  return { dif, dea, bar };
}

function sub(a: Series, b: Series): Series {
  return a.map((v, t) => (v !== null && b[t] !== null ? v - (b[t] as number) : null));
}
function scalarMul(a: Series, k: number): Series {
  return a.map((v) => (v !== null ? v * k : null));
}

// KDJ（9日 RSV，SMA 平滑，初值 50）
export function kdjCalc(h: Series, l: Series, c: Series, n = 9): { k: Series; d: Series; j: Series } {
  const k: Series = new Array(c.length).fill(null);
  const d: Series = new Array(c.length).fill(null);
  const j: Series = new Array(c.length).fill(null);
  let kp = 50, dp = 50;
  for (let t = 0; t < c.length; t++) {
    if (c[t] === null || h[t] === null || l[t] === null) continue;
    let hh = -Infinity, ll = Infinity, ok = true;
    for (let i = Math.max(0, t - n + 1); i <= t; i++) {
      const hv = h[i], lv = l[i];
      if (hv === null || lv === null) { ok = false; break; }
      if (hv > hh) hh = hv;
      if (lv < ll) ll = lv;
    }
    if (!ok || hh === ll || !isFinite(hh)) continue;
    const rsv = ((c[t] as number) - ll) / (hh - ll) * 100;
    kp = (2 / 3) * kp + (1 / 3) * rsv;
    dp = (2 / 3) * dp + (1 / 3) * kp;
    k[t] = kp; d[t] = dp; j[t] = 3 * kp - 2 * dp;
  }
  return { k, d, j };
}

// RSI（窗口内涨跌幅均值法）
export function rsiCalc(c: Series, n: number): Series {
  const out: Series = new Array(c.length).fill(null);
  for (let t = n; t < c.length; t++) {
    let gain = 0, loss = 0, cnt = 0;
    for (let i = t - n + 1; i <= t; i++) {
      const a = c[i - 1] === undefined || c[i - 1] === null || c[i] === null ? null : (c[i] as number) / (c[i - 1] as number) - 1;
      if (a === null) continue;
      if (a > 0) gain += a; else loss -= a;
      cnt++;
    }
    if (cnt < Math.ceil(n * 0.8)) continue;
    const avgGain = gain / cnt, avgLoss = loss / cnt;
    out[t] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function atrCalc(h: Series, l: Series, c: Series, n = 14): { atr: Series; atrRatio: Series } {
  const tr: Series = new Array(c.length).fill(null);
  for (let t = 1; t < c.length; t++) {
    if (h[t] === null || l[t] === null || c[t] === null || c[t - 1] === null) continue;
    tr[t] = Math.max(
      (h[t] as number) - (l[t] as number),
      Math.abs((h[t] as number) - (c[t - 1] as number)),
      Math.abs((l[t] as number) - (c[t - 1] as number)),
    );
  }
  const atr = sma(tr, n);
  const atrRatio = atr.map((v, t) => (v !== null && c[t] !== null && (c[t] as number) > 0 ? (v / (c[t] as number)) * 100 : null));
  return { atr, atrRatio };
}

// 20日市场成本（VWAP20）定义已下移至「任务C」区块（加成交额缺失=宁缺勿假纪律）

// 交叉信号：a 上穿 b（昨日 a<=b 且今日 a>b）
export function crossUp(a: Series, b: Series): Series {
  return a.map((v, t) => {
    if (t === 0 || v === null || b[t] === null || a[t - 1] === null || b[t - 1] === null) return 0;
    return a[t - 1]! <= b[t - 1]! && v > (b[t] as number) ? 1 : 0;
  });
}

// ---------- P0补齐·任务C：纯公式（缠论/TD/江恩/高斯） ----------
// 全部为逐日 OHLCV 确定性计算，可被 node:test 直跑；口径注释即字段定义，禁止事后凭结果改口径。

// 20日市场成本（VWAP20：累计成交额/累计成交量）
// 数据纪律：无成交额（null 或 <=0，如腾讯日K）→ 整段视为缺失输出 null（宁缺勿假，禁止收盘价近似）
export function vwapCalc(c: Series, v: Series, amount: Series, n = 20): { vwap: Series; pos: Series } {
  const vwap: Series = new Array(c.length).fill(null);
  for (let t = n - 1; t < c.length; t++) {
    let sa = 0, sv = 0, ok = true;
    for (let i = t - n + 1; i <= t; i++) {
      const a = amount[i], vv = v[i];
      if (a === null || !(a > 0) || vv === null || vv <= 0) { ok = false; break; }
      sa += a; sv += vv;
    }
    if (!ok || sv <= 0) continue;
    vwap[t] = sa / sv;
  }
  const pos = vwap.map((w, t) => (w !== null && w > 0 && c[t] !== null ? ((c[t] as number) / w - 1) * 100 : null));
  return { vwap, pos };
}

// 缠论K线包含处理（简化口径）：逐根扫描，出现包含关系时并入前一根——
// 方向取合并前最后两根处理K的相对方向（高升且低升=上，高降且低降=下，无法判定按上处理）：
//   向上：合并后 high=max(highs), low=max(lows)；向下：high=min(highs), low=min(lows)。
// end = 该处理K覆盖的原始K最后一根的索引。停牌/缺值K线跳过不参与。
export interface ChanBar { hi: number; lo: number; end: number }

export function chanMerge(h: Series, l: Series): ChanBar[] {
  const out: ChanBar[] = [];
  for (let t = 0; t < h.length; t++) {
    const hv = h[t], lv = l[t];
    if (hv === null || lv === null) continue;
    if (out.length >= 1) {
      const prev = out[out.length - 1];
      const contained = (prev.hi >= hv && prev.lo <= lv) || (hv >= prev.hi && lv <= prev.lo);
      if (contained) {
        const p2 = out.length >= 2 ? out[out.length - 2] : null;
        const up = !p2 || prev.hi >= p2.hi; // 无法判向时默认向上
        if (up) { prev.hi = Math.max(prev.hi, hv); prev.lo = Math.max(prev.lo, lv); }
        else { prev.hi = Math.min(prev.hi, hv); prev.lo = Math.min(prev.lo, lv); }
        prev.end = t;
        continue;
      }
    }
    out.push({ hi: hv, lo: lv, end: t });
  }
  return out;
}

// 分型（处理K序列上的标准3-K定义）：顶分型 = 中间K的 high 与 low 均为三K中最高；底分型镜像。
// 信号落在「第三根处理K对应的最后一根原始K」处（分型确认日）；其余已越过确认窗的位置记 0，序列头部数据不足处记 null。
export function chanFractalFlags(h: Series, l: Series): { top: Series; bottom: Series } {
  const n = h.length;
  const top: Series = new Array(n).fill(null);
  const bottom: Series = new Array(n).fill(null);
  const bars = chanMerge(h, l);
  for (let i = 1; i + 1 < bars.length; i++) {
    const a = bars[i - 1], b = bars[i], c = bars[i + 1];
    const at = c.end;
    top[at] = b.hi > a.hi && b.hi > c.hi && b.lo > a.lo && b.lo > c.lo ? 1 : 0;
    bottom[at] = b.lo < a.lo && b.lo < c.lo && b.hi < a.hi && b.hi < c.hi ? 1 : 0;
  }
  return { top, bottom };
}

// 中枢（任务书允许的简化口径，非严格笔/线段构建）：
// 取「当日之前已完成」的最近 ZW=6 根处理K的区间重叠 [ZD=max(low), ZG=min(high)]，ZG>ZD 才成立中枢。
// cz_break_up：昨日收盘 ≤ 昨日中枢上沿，今日收盘 > 今日中枢上沿（放量与否不参与，保持纯形态）；cz_break_down 镜像。
// 三买（简化）：中枢成立且当日 low > ZG（回踩不跌回中枢）且收阳；三卖（简化）：中枢成立且当日 high < ZD 且收阴。
export function chanZhongshuSignals(
  h: Series, l: Series, c: Series, o: Series, zw = 6,
): { breakUp: Series; breakDown: Series; thirdBuy: Series; thirdSell: Series } {
  const n = h.length;
  const breakUp: Series = new Array(n).fill(null);
  const breakDown: Series = new Array(n).fill(null);
  const thirdBuy: Series = new Array(n).fill(null);
  const thirdSell: Series = new Array(n).fill(null);
  const bars = chanMerge(h, l);
  // zgZd[t]：最后一根原始K < t（即 t 之前已完成）的最近 zw 根处理K的中枢；null=不成立
  const zg: (number | null)[] = new Array(n).fill(null);
  const zd: (number | null)[] = new Array(n).fill(null);
  let bi = 0; // bars[bi].end < t 的最大 bi+1 = 已完成根数
  for (let t = 0; t < n; t++) {
    while (bi < bars.length && bars[bi].end < t) bi++;
    if (bi >= zw) {
      let hi = Infinity, lo = -Infinity;
      for (let i = bi - zw; i < bi; i++) { hi = Math.min(hi, bars[i].hi); lo = Math.max(lo, bars[i].lo); }
      if (hi > lo) { zg[t] = hi; zd[t] = lo; }
    }
  }
  for (let t = 0; t < n; t++) {
    const cv = c[t], lv = l[t], hv = h[t], ov = o[t];
    if (cv === null || lv === null || hv === null || ov === null) continue;
    if (zg[t] === null) continue;
    const prevC = t > 0 ? c[t - 1] : null;
    const prevZg = t > 0 ? zg[t - 1] : null;
    const prevZd = t > 0 ? zd[t - 1] : null;
    breakUp[t] = prevC !== null && prevZg !== null && prevC <= prevZg && cv > zg[t]! ? 1 : 0;
    breakDown[t] = prevC !== null && prevZd !== null && prevC >= prevZd && cv < zd[t]! ? 1 : 0;
    thirdBuy[t] = lv > zg[t]! && cv > ov ? 1 : 0;
    thirdSell[t] = hv < zd[t]! && cv < ov ? 1 : 0;
  }
  return { breakUp, breakDown, thirdBuy, thirdSell };
}

// TD序列（Tom DeMark 简化实现，口径如下）：
// Setup：td_buy_seq = 连续「close < 4根前close」的计数（中断即清零）；td_sell_seq 镜像。
// td_signal = Setup 首次达到 9 的完成日（买入/卖出任一完成即为 1）。
// Countdown13：某向 Setup 完成后开始计数；买入侧「close < 2根前low」+1、「close > 2根前high」清零，其余保持；
// 计到 13 且距该 Setup 完成 ≤ 21 根 → td13_buy_qualified=1（卖出侧镜像）。
export function tdSeq(h: Series, l: Series, c: Series): {
  buy: Series; sell: Series; signal: Series; buy13q: Series; sell13q: Series;
} {
  const n = c.length;
  const buy: Series = new Array(n).fill(null);
  const sell: Series = new Array(n).fill(null);
  const signal: Series = new Array(n).fill(null);
  const buy13q: Series = new Array(n).fill(null);
  const sell13q: Series = new Array(n).fill(null);
  let bCnt = 0, sCnt = 0, cdB = 0, cdS = 0, lastB = -999, lastS = -999;
  for (let t = 0; t < n; t++) {
    const cv = c[t];
    if (cv === null) continue;
    if (t >= 4 && c[t - 4] !== null) {
      bCnt = cv < c[t - 4]! ? bCnt + 1 : 0;
      sCnt = cv > c[t - 4]! ? sCnt + 1 : 0;
    }
    const doneB = bCnt === 9, doneS = sCnt === 9; // 恰等于9 = 首次达到（计数连续，9 只出现一次）
    if (doneB) lastB = t;
    if (doneS) lastS = t;
    signal[t] = doneB || doneS ? 1 : 0;
    // 倒计时仅在对应 Setup 完成后累计
    if (t >= 2 && l[t - 2] !== null && h[t - 2] !== null) {
      if (t > lastB) {
        if (cv < l[t - 2]!) cdB++; else if (cv > h[t - 2]!) cdB = 0;
      } else cdB = 0;
      if (t > lastS) {
        if (cv > h[t - 2]!) cdS++; else if (cv < l[t - 2]!) cdS = 0;
      } else cdS = 0;
    }
    buy13q[t] = cdB >= 13 && t - lastB <= 21 ? 1 : 0;
    sell13q[t] = cdS >= 13 && t - lastS <= 21 ? 1 : 0;
    buy[t] = bCnt; sell[t] = sCnt;
  }
  return { buy, sell, signal, buy13q, sell13q };
}

// 高斯通道（零滞后近似）：
// mid = 收盘价在最近 WIN=40 根上的高斯加权均线，权重 w(k)=exp(-0.5*((k-(WIN-1)/2)/(0.25*WIN))^2)；
// std = 同一组权重的加权标准差；upper/lower = mid ± MULT(2)×std；缺失K线跳过并按有效根数≥WIN*0.6 才输出。
export function gaussChannel(c: Series, win = 40, sigmaRatio = 0.25, mult = 2): {
  mid: Series; upper: Series; lower: Series;
} {
  const n = c.length;
  const mid: Series = new Array(n).fill(null);
  const upper: Series = new Array(n).fill(null);
  const lower: Series = new Array(n).fill(null);
  const wts: number[] = [];
  for (let k = 0; k < win; k++) wts.push(Math.exp(-0.5 * Math.pow((k - (win - 1) / 2) / (sigmaRatio * win), 2)));
  for (let t = win - 1; t < n; t++) {
    let sw = 0, swx = 0, cnt = 0;
    for (let k = 0; k < win; k++) {
      const v = c[t - win + 1 + k];
      if (v === null) continue;
      sw += wts[k]; swx += wts[k] * v; cnt++;
    }
    if (cnt < Math.ceil(win * 0.6) || sw <= 0) continue;
    const m = swx / sw;
    let varr = 0;
    for (let k = 0; k < win; k++) {
      const v = c[t - win + 1 + k];
      if (v === null) continue;
      varr += wts[k] * (v - m) * (v - m);
    }
    const sd = Math.sqrt(varr / sw);
    mid[t] = m; upper[t] = m + mult * sd; lower[t] = m - mult * sd;
  }
  return { mid, upper, lower };
}

// 江恩支撑信号（时方格简化口径，非软件原公式）：
// 基准=最近 BASE=120 根内首个最低低点 L（索引 dL，不含当日）；
// 支撑线 line_k(t) = L × (1 + r_k × (t - dL))，斜率 r：1x1=1%×L/交易日、1x2=0.5%、2x1=2%。
// sig_k(t)=1 ⇔ 当日 low 落入 line×[0.99,1.01]（回踩到线±1%带内）且 close ≥ line（收回线上）且 close>open（收阳）。
export function gannSupportSig(h: Series, l: Series, c: Series, o: Series, base = 120): {
  sig11: Series; sig12: Series; sig21: Series;
} {
  const n = c.length;
  const sig11: Series = new Array(n).fill(null);
  const sig12: Series = new Array(n).fill(null);
  const sig21: Series = new Array(n).fill(null);
  for (let t = base; t < n; t++) {
    let L = Infinity, dL = -1;
    for (let i = t - base; i < t; i++) {
      const lv = l[i];
      if (lv !== null && lv < L) { L = lv; dL = i; } // 首个最低点（严格小于 → 取最早）
    }
    if (dL < 0 || !isFinite(L) || L <= 0) continue;
    const k = t - dL;
    const cv = c[t], lv = l[t], ov = o[t];
    if (cv === null || lv === null || ov === null) continue;
    const check = (r: number): 0 | 1 => {
      const line = L * (1 + r * k);
      return lv <= line * 1.01 && lv >= line * 0.99 && cv >= line && cv > ov ? 1 : 0;
    };
    sig11[t] = check(0.01); sig12[t] = check(0.005); sig21[t] = check(0.02);
  }
  return { sig11, sig12, sig21 };
}

// ---------- 面板：全子集 × 全日期的因子矩阵 ----------

export interface KPanel {
  dates: string[]; // 升序
  symbols: string[];
  fields: Map<string, (Series)[]>; // [股票][日期]
}

export interface MetaLike {
  symbol: string;
  pe?: number; pb?: number; marketCap?: number; floatCap?: number;
  turnover?: number; amount?: number; changePct?: number; volumeRatio?: number;
  amplitude?: number; mainNet?: number; // mainNet: 元
}

export interface BarsLike {
  date: string; o: number; h: number; l: number; c: number; v: number; amount?: number;
}

const limitUpPctOf = (symbol: string): number =>
  symbol.endsWith(".BJ") ? 29.85 : /^(688|689)\./.test(symbol) || /^30\d{4}\.(SZ)$/.test(symbol) ? 19.85 : 9.85;

// ---------- 快照口径涨停判定（纯逻辑，node:test 可直跑；screener/profile/sentiment 共用） ----------
// §三（验收修复）：实时「是否涨停」优先用实时快照（snapshot_time），K线最后一根（bar_time）可能滞后，
// 不得覆盖快照结论；不可判（新股无涨跌幅限制期 / 缺字段）→ 返回 null=UNKNOWN，绝不冒充 false。
export interface LimitEval {
  limitPrice: number; // 当日涨停价
  touched: boolean; // 触板（high ≥ 涨停价）
  sealed: boolean; // 收盘涨停（price ≥ 涨停价）
}

/** 涨停限制比例（0.05/0.10/0.20/0.30）；注册制板块（含ST）20%，北交所30%，主板ST 5%，其余10% */
export function limitRatio(symbol: string, name: string): number {
  if (/^(300|301|688|689)/.test(symbol.slice(0, 6))) return 0.20;
  if (symbol.endsWith(".BJ")) return 0.30;
  if (/ST/i.test(name)) return 0.05;
  return 0.10;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export interface LimitSnapshotInput {
  symbol: string; name: string;
  price?: number; high?: number; prevClose?: number;
}

/** 快照口径涨停判定；prevClose/high 缺失或新股（N=上市首日、C=上市2~5日无涨跌幅限制期）返回 null（不参与判定） */
export function evalLimitSnapshot(m: LimitSnapshotInput): LimitEval | null {
  if (/^[NC]/.test(m.name)) return null;
  const pc = m.prevClose, hi = m.high, px = m.price;
  if (pc === undefined || pc <= 0 || hi === undefined || px === undefined || px <= 0) return null;
  const limitPrice = round2(pc * (1 + limitRatio(m.symbol, m.name)));
  return { limitPrice, touched: hi >= limitPrice - 1e-9, sealed: px >= limitPrice - 1e-9 };
}

// ---------- 庄家宝体系（zsb）纯公式（通达信口径；任务书§六：不自行优化、不改参数） ----------

/**
 * 通达信 SMA(X,N,M) 递归加权平均：Y=(M*X+(N-M)*Y')/N —— 这不是简单移动平均（本文件 sma() 不可混用）。
 * 初值：首个有效 X 作为 Y'（与本项目 ema() 的种子约定一致）；null 输入沿用前值。
 */
export function tdxSma(x: Series, n: number, m: number): Series {
  const out: Series = new Array(x.length).fill(null);
  let prev: number | null = null;
  for (let t = 0; t < x.length; t++) {
    const v = x[t];
    if (v === null || !isFinite(v)) { out[t] = prev; continue; }
    prev = prev === null ? v : (m * v + (n - m) * prev) / n;
    out[t] = prev;
  }
  return out;
}

/** zsb_rsi_v：LC:=REF(VOL,1); RSI_V:=SMA(MAX(VOL-LC,0),N,1)/SMA(ABS(VOL-LC),N,1)*100（SMA 递归） */
export function rsiVCalc(v: Series, n: number): Series {
  const up: Series = new Array(v.length).fill(null);
  const dn: Series = new Array(v.length).fill(null);
  for (let t = 0; t < v.length; t++) {
    if (t === 0 || v[t] === null || v[t - 1] === null) continue;
    const d = (v[t] as number) - (v[t - 1] as number);
    up[t] = Math.max(d, 0);
    dn[t] = Math.abs(d);
  }
  const su = tdxSma(up, n, 1);
  const sd = tdxSma(dn, n, 1);
  return su.map((u, t) => {
    const d = sd[t];
    if (u === null || d === null) return null;
    if (d === 0) return u === 0 ? null : 100; // 量能恒定时不可判（不伪造 0/100）
    return (u / d) * 100;
  });
}

/** zsb_retail：散户:=100*(HHV(HIGH,34)-CLOSE)/(HHV(HIGH,34)-LLV(LOW,34));（M=34 固定） */
export function retailCalc(h: Series, l: Series, c: Series, m = 34): Series {
  const out: Series = new Array(c.length).fill(null);
  for (let t = m - 1; t < c.length; t++) {
    if (c[t] === null) continue;
    let hh = -Infinity, ll = Infinity, ok = true;
    for (let i = t - m + 1; i <= t; i++) {
      const hv = h[i], lv = l[i];
      if (hv === null || lv === null) { ok = false; break; }
      if (hv > hh) hh = hv;
      if (lv < ll) ll = lv;
    }
    if (!ok || hh === ll) continue;
    out[t] = (100 * (hh - (c[t] as number))) / (hh - ll);
  }
  return out;
}

/**
 * 控盘（纯价格中间量，≠需筹码分布的「高度控盘」；不对外注册为筛选字段）：
 * VAR1:=EMA(EMA(CLOSE,9),9); 控盘:=(VAR1-REF(VAR1,1))/REF(VAR1,1)*1000;
 */
export function kongpanCalc(c: Series): Series {
  const var1 = ema(ema(c, 9), 9);
  return var1.map((v, t) => {
    const p = t > 0 ? var1[t - 1] : null;
    return v !== null && p !== null && p !== 0 ? ((v - p) / p) * 1000 : null;
  });
}

// 参数化占位（原始资料未明确 N 值 → param_n_pending，确认后只改这里）
export const ZSB_RSI_V_N = 14; // zsb_rsi_v 的 N（默认14，待确认）
export const ZSB_BDW_N = 20;   // zsb_bdw 的 N（默认20，待确认）
export const ZSB_DEALER_RSV_N = 81; // 原始公式固定参数，不要改
export const ZSB_DEALER_EMA_N = 6;  // 原始公式固定参数，不要改
export const ZSB_RETAIL_M = 34;     // 原始公式固定参数，不要改

/** zsb_dealer：庄家:=EMA(J,6)，J 来自 81 日 RSV 的 KDJ（复用 kdjCalc 的 SMA 递归实现） */
export function dealerCalc(h: Series, l: Series, c: Series): Series {
  return ema(kdjCalc(h, l, c, ZSB_DEALER_RSV_N).j, ZSB_DEALER_EMA_N);
}

/** zsb_bdw：BDW:=(CLOSE-REF(CLOSE,N))/REF(CLOSE,N)*VOL*100（N 参数化，默认20） */
export function bdwCalc(c: Series, v: Series, n = ZSB_BDW_N): Series {
  return c.map((cv, t) => {
    const ref = t >= n ? c[t - n] : null;
    const vol = v[t];
    return cv !== null && ref !== null && ref > 0 && vol !== null ? ((cv - ref) / ref) * vol * 100 : null;
  });
}

// ---------- P2 剩余因子包（任务书 2026-09-19）：纯函数（node:test 可直跑） ----------

/** HHV/LLV：滚动 N 日最高/最低（含当日，通达信字面口径）；窗口内含 null → null */
export function hhv(x: Series, n: number): Series {
  return x.map((_, t) => {
    if (t < n - 1) return null;
    let m = -Infinity;
    for (let i = t - n + 1; i <= t; i++) { const val = x[i]; if (val === null) return null; if (val > m) m = val; }
    return m;
  });
}
export function llv(x: Series, n: number): Series {
  return x.map((_, t) => {
    if (t < n - 1) return null;
    let m = Infinity;
    for (let i = t - n + 1; i <= t; i++) { const val = x[i]; if (val === null) return null; if (val < m) m = val; }
    return m;
  });
}

/** 不含当日的滚动 N 日最低/最高：t 时刻取 [t-n, t-1]（项目支撑/压力线标准口径，= REF(LLV/HHV(N),1)） */
export function refRollMin(x: Series, n: number): Series {
  return x.map((_, t) => {
    if (t < n) return null;
    let m = Infinity;
    for (let i = t - n; i <= t - 1; i++) { const val = x[i]; if (val === null) return null; if (val < m) m = val; }
    return m;
  });
}
export function refRollMax(x: Series, n: number): Series {
  return x.map((_, t) => {
    if (t < n) return null;
    let m = -Infinity;
    for (let i = t - n; i <= t - 1; i++) { const val = x[i]; if (val === null) return null; if (val > m) m = val; }
    return m;
  });
}

/** (X-REF(X,N))/REF(X,N)*100；基准缺失或为 0 → null（不可判，不伪造） */
export function pctChange(x: Series, n: number): Series {
  return x.map((v, t) => {
    const p = t >= n ? x[t - n] : null;
    return v !== null && p !== null && p !== 0 ? (v / p - 1) * 100 : null;
  });
}

/** vwap_full：自样本起累计（仅累计有效量额日）；尚无任何有效日 → null */
export function vwapFullCalc(v: Series, amount: Series): Series {
  const out: Series = new Array(v.length).fill(null);
  let sa = 0, sv = 0;
  for (let t = 0; t < v.length; t++) {
    const a = amount[t], vv = v[t];
    if (a !== null && a > 0 && vv !== null && vv > 0) { sa += a; sv += vv; }
    out[t] = sv > 0 ? sa / sv : null;
  }
  return out;
}

/** 缠论简化中枢（任务书口径）：区间=[LLV(L,n), HHV(H,n)]（含当日，n=10） */
export function czRangeSignals(h: Series, l: Series, c: Series, n = 10): {
  active: Series; start: Series; end: Series; inside: Series;
} {
  const zg = hhv(h, n), zd = llv(l, n);
  const T = c.length;
  const active: Series = new Array(T).fill(null);
  const start: Series = new Array(T).fill(null);
  const end: Series = new Array(T).fill(null);
  const inside: Series = new Array(T).fill(null);
  const inRange: (0 | 1 | null)[] = new Array(T).fill(null);
  const width: (number | null)[] = zg.map((g, t) => (g !== null && zd[t] !== null ? g - zd[t]! : null));
  for (let t = 0; t < T; t++) {
    const cv = c[t], g = zg[t], d = zd[t];
    if (cv === null || g === null || d === null) continue;
    const insideFlag: 0 | 1 = cv >= d && cv <= g ? 1 : 0;
    inRange[t] = insideFlag;
    active[t] = insideFlag;
    const prev = t > 0 ? inRange[t - 1] : null;
    if (prev !== null) {
      start[t] = insideFlag === 1 && prev === 0 ? 1 : 0;
      end[t] = insideFlag === 0 && prev === 1 ? 1 : 0;
    }
    const pw = t > 0 ? width[t - 1] : null;
    if (insideFlag === 1 && width[t] !== null && pw !== null) inside[t] = width[t]! < pw ? 1 : 0;
    else inside[t] = null;
  }
  return { active, start, end, inside };
}

/**
 * 支撑/压力信号族（250/144 变体通用，任务书 A4）：
 * 线口径 = refRollMin/refRollMax（不含当日，项目标准；理由见 DEFS 区块口径纪律注释）。
 * n=250 时需 ≥251 根K线才开始有值 —— 面板 lookback 必须大于窗口。
 */
export function srSignals(h: Series, l: Series, c: Series, v: Series, n: number, vma20: Series): {
  bounce: Series; rebound: Series; supportBreak: Series; resistanceBreakoutVol: Series;
  supportNear: Series; resistanceNear: Series; supportBreakdown2: Series; resistanceBreakoutConf2: Series;
  supLine: Series; resLine: Series;
} {
  const sup = refRollMin(l, n), res = refRollMax(h, n);
  const T = c.length;
  const mk = (): Series => new Array(T).fill(null);
  const bounce = mk(), rebound = mk(), supportBreak = mk(), rBreakVol = mk();
  const sNear = mk(), rNear = mk(), sDown2 = mk(), rConf2 = mk();
  for (let t = 0; t < T; t++) {
    const cv = c[t], lv = l[t], hv = h[t], s = sup[t], r = res[t];
    const pc = t > 0 ? c[t - 1] : null;
    const ps = t > 0 ? sup[t - 1] : null, pr = t > 0 ? res[t - 1] : null;
    const vol = v[t], mv = vma20[t];
    if (cv !== null && lv !== null && pc !== null && s !== null) bounce[t] = lv <= s * 1.02 && cv > pc ? 1 : 0;
    if (cv !== null && hv !== null && pc !== null && r !== null) rebound[t] = hv >= r * 0.98 && cv < pc ? 1 : 0;
    if (cv !== null && s !== null && pc !== null && ps !== null) supportBreak[t] = cv < s && pc >= ps ? 1 : 0;
    if (cv !== null && r !== null && vol !== null && mv !== null && mv > 0) rBreakVol[t] = cv > r && vol > mv * 1.5 ? 1 : 0;
    if (cv !== null && s !== null && s > 0) sNear[t] = cv >= s && ((cv - s) / s) * 100 < 3 ? 1 : 0;
    if (cv !== null && r !== null && r > 0) rNear[t] = cv <= r && ((r - cv) / r) * 100 < 3 ? 1 : 0;
    if (cv !== null && s !== null && pc !== null && ps !== null) sDown2[t] = cv < s && pc < ps ? 1 : 0;
    if (cv !== null && r !== null && pc !== null && pr !== null) rConf2[t] = cv > r && pc > pr ? 1 : 0;
  }
  return { bounce, rebound, supportBreak, resistanceBreakoutVol: rBreakVol, supportNear: sNear, resistanceNear: rNear, supportBreakdown2: sDown2, resistanceBreakoutConf2: rConf2, supLine: sup, resLine: res };
}

/**
 * K线形态标签（candle_patterns_text 的纯函数实现；面板字符串列未支持前仅供画像/AI 使用）：
 * 优先级：吞没 > 大阳/大阴 > 十字星 > 锤头；无匹配 → null。
 * 大阳：收阳且较昨收涨幅≥3%；大阴镜像；十字星：实体≤10%×振幅（振幅>0）；
 * 锤头：下影≥2×实体 且 上影≤0.5×实体 且 实体>0；
 * 看涨吞没：今阳包昨阴（今实体完全包住昨实体）；看跌吞没镜像。
 */
export function candlePatternCalc(o: Series, h: Series, l: Series, c: Series): (string | null)[] {
  const out: (string | null)[] = new Array(c.length).fill(null);
  for (let t = 1; t < c.length; t++) {
    const cv = c[t], ov = o[t], hv = h[t], lv = l[t], pc = c[t - 1], po = o[t - 1];
    if (cv === null || ov === null || hv === null || lv === null || pc === null || po === null || pc <= 0) continue;
    const body = Math.abs(cv - ov), rng = hv - lv;
    const upper = hv - Math.max(cv, ov), lower = Math.min(cv, ov) - lv;
    const ret = cv / pc - 1;
    const prevBody = Math.abs(pc - po);
    const bullEngulf = cv > ov && pc < po && cv >= po && ov <= pc && body >= prevBody;
    const bearEngulf = cv < ov && pc > po && cv <= po && ov >= pc && body >= prevBody;
    if (bullEngulf) { out[t] = "看涨吞没"; continue; }
    if (bearEngulf) { out[t] = "看跌吞没"; continue; }
    if (cv > ov && ret >= 0.03) { out[t] = "大阳"; continue; }
    if (cv < ov && ret <= -0.03) { out[t] = "大阴"; continue; }
    if (rng > 0 && body <= rng * 0.1) { out[t] = "十字星"; continue; }
    if (body > 0 && lower >= body * 2 && upper <= body * 0.5) { out[t] = "锤头"; continue; }
    out[t] = null;
  }
  return out;
}

// 由子集日K + 快照元数据构建因子面板（含快照常数列，便于统一取值；历史匹配时只用 kline 字段）
export function buildFieldPanel(symbols: string[], barsList: BarsLike[][], metas: (MetaLike | undefined)[]): KPanel {
  const dateSet = new Set<string>();
  for (const bars of barsList) for (const b of bars) dateSet.add(b.date);
  const dates = [...dateSet].sort();
  const T = dates.length;
  const idxOf = new Map(dates.map((d, i) => [d, i]));

  const base: Record<string, (k: BarsLike) => number> = {
    o: (b) => b.o, h: (b) => b.h, l: (b) => b.l, c: (b) => b.c, v: (b) => b.v,
    amount: (b) => b.amount ?? 0,
  };
  const fields = new Map<string, Series[]>();
  for (const [name, get] of Object.entries(base)) {
    fields.set(name, barsList.map((bars) => {
      const s: Series = new Array(T).fill(null);
      for (const b of bars) {
        const i = idxOf.get(b.date);
        if (i !== undefined) s[i] = get(b);
      }
      return s;
    }));
  }
  // ret（当日涨跌幅 %）
  const cArr = fields.get("c")!;
  const oArr = fields.get("o")!;
  fields.set("ret", cArr.map((s, si) => s.map((v, t) => {
    const prev = t > 0 ? s[t - 1] : null;
    return v !== null && prev !== null && prev > 0 ? (v / prev - 1) * 100 : null;
  })));
  // 快照常数列（对齐到最后一根K线的日期；历史日期上同样填充——仅供展示，绝不参与历史匹配）
  const snapOf = (m: MetaLike | undefined): Record<string, number | null> => ({
    pe_ttm: m?.pe ?? null,
    pb: m?.pb ?? null,
    market_cap_yi: m?.marketCap != null ? m.marketCap / 1e8 : null,
    floatcap_yi: m?.floatCap != null ? m.floatCap / 1e8 : null,
    change_pct: m?.changePct ?? null,
    turnover_rate: m?.turnover ?? null,
    volume_ratio: m?.volumeRatio ?? null,
    amplitude: m?.amplitude ?? null,
    amount_yi: m?.amount != null ? m.amount / 1e8 : null,
    main_net_yi: m?.mainNet != null ? m.mainNet / 1e8 : null,
  });
  for (const key of Object.keys(snapOf(undefined))) {
    fields.set(key, symbols.map((_, si) => {
      const val = (snapOf(metas[si]) as Record<string, number | null>)[key];
      return new Array(T).fill(val);
    }));
  }

  // 派生 K 线字段
  const h = fields.get("h")!, l = fields.get("l")!, v = fields.get("v")!, amt = fields.get("amount")!;
  const ret = fields.get("ret")!;

  const maKeys = [5, 10, 20, 60, 90, 144];
  const maSeries = new Map<number, Series[]>();
  for (const n of maKeys) {
    maSeries.set(n, cArr.map((s) => sma(s, n)));
    fields.set(`above_ma_${n}`, maSeries.get(n)!.map((mas, si) =>
      mas.map((m, t) => (m !== null && cArr[si][t] !== null ? (cArr[si][t]! >= m ? 1 : 0) : null))));
  }
  fields.set("ma_struct", symbols.map((_, si) => {
    const m5 = maSeries.get(5)![si], m10 = maSeries.get(10)![si], m20 = maSeries.get(20)![si];
    return m5.map((m, t) => {
      const c = cArr[si][t];
      return m !== null && m10[t] !== null && m20[t] !== null && c !== null && c > m && m > m10[t]! && m10[t]! > m20[t]! ? 1 : 0;
    });
  }));

  const e14 = cArr.map((s) => ema(s, 14));
  const e26 = cArr.map((s) => ema(s, 26));
  fields.set("ema14_gt_ema26", symbols.map((_, si) =>
    e14[si].map((a, t) => (a !== null && e26[si][t] !== null ? (a > e26[si][t]! ? 1 : 0) : null))));

  const macds = cArr.map((s) => macdCalc(s));
  fields.set("macd_dif", macds.map((m) => m.dif));
  fields.set("macd_dea", macds.map((m) => m.dea));
  fields.set("macd", macds.map((m) => m.bar));
  fields.set("macd_cross", macds.map((m) => crossUp(m.dif, m.dea)));

  const kdjs = symbols.map((_, si) => kdjCalc(h[si], l[si], cArr[si]));
  fields.set("kdj_k", kdjs.map((m) => m.k));
  fields.set("kdj_d", kdjs.map((m) => m.d));
  fields.set("kdj_j", kdjs.map((m) => m.j));
  fields.set("kdj_cross", kdjs.map((m) => crossUp(m.k, m.d)));

  for (const n of [7, 14, 24]) fields.set(`rsi_${n}`, cArr.map((s) => rsiCalc(s, n)));

  const atrs = symbols.map((_, si) => atrCalc(h[si], l[si], cArr[si]));
  fields.set("atr_ratio_14", atrs.map((m) => m.atrRatio));

  fields.set("upper_shadow_ratio", symbols.map((_, si) => h[si].map((hv, t) => {
    const c = cArr[si][t], o = oArr[si][t], lv = l[si][t];
    if (hv === null || c === null || o === null || lv === null) return null;
    const body = Math.abs(c - o);
    const up = hv - Math.max(c, o);
    return body > 0 ? up / body : up > 0 ? 9.99 : 0;
  })));
  fields.set("lower_shadow_ratio", symbols.map((_, si) => l[si].map((lv, t) => {
    const c = cArr[si][t], o = oArr[si][t], hv = h[si][t];
    if (lv === null || c === null || o === null || hv === null) return null;
    const body = Math.abs(c - o);
    const dn = Math.min(c, o) - lv;
    return body > 0 ? dn / body : dn > 0 ? 9.99 : 0;
  })));

  // 量能信号（当日量 vs 5日均量）
  const vma5 = v.map((s) => sma(s, 5));
  fields.set("double_volume_signal", symbols.map((_, si) =>
    v[si].map((x, t) => (x !== null && vma5[si][t] !== null && vma5[si][t]! > 0 ? (x >= vma5[si][t]! * 2 ? 1 : 0) : null))));
  fields.set("volume_signal", symbols.map((_, si) =>
    v[si].map((x, t) => (x !== null && vma5[si][t] !== null && vma5[si][t]! > 0 ? (x >= vma5[si][t]! * 1.5 ? 1 : 0) : null))));
  fields.set("is_limit_up", ret.map((s, si) =>
    s.map((r, t) => (r === null ? null : (r >= limitUpPctOf(symbols[si]) ? 1 : 0)))));

  // VWAP / 成本
  const vwaps = symbols.map((_, si) => vwapCalc(cArr[si], v[si], amt[si], 20));
  fields.set("vwap20_filter", symbols.map((_, si) =>
    vwaps[si].vwap.map((w, t) => (w !== null && cArr[si][t] !== null ? (cArr[si][t]! >= w ? 1 : 0) : null))));
  fields.set("vwap_pos", vwaps.map((m) => m.pos));
  fields.set("vwap20_up3", vwaps.map((m) => m.vwap.map((w, t) => {
    const p = t >= 3 ? m.vwap[t - 3] : null;
    return w !== null && p !== null ? (w > p ? 1 : 0) : null;
  })));
  fields.set("above_cost_20", fields.get("vwap20_filter")!.map((s) => s.map((x) => x)));
  fields.set("break_cost_20", (() => {
    const filt = fields.get("vwap20_filter")!;
    return filt.map((s) => s.map((x, t) => (t > 0 && x === 1 && s[t - 1] === 0 ? 1 : 0)));
  })());
  // VWAP 体系补全（任务C；无量额K线整段 null，宁缺勿假）
  fields.set("vwap20", vwaps.map((m) => m.vwap));
  const vwapSlope3 = vwaps.map((m) => m.vwap.map((w, t) => {
    const p = t >= 3 ? m.vwap[t - 3] : null;
    return w !== null && p !== null && p > 0 ? (w / p - 1) * 100 : null;
  }));
  fields.set("vwap20_slope3", vwapSlope3);
  const up3 = fields.get("vwap20_up3")!;
  // vwap_score = 站上VWAP(1) + VWAP20三日上行(1) + 偏离≤8%（追高可控,1），0~3
  fields.set("vwap_score", symbols.map((_, si) => vwaps[si].vwap.map((w, t) => {
    const cv = cArr[si][t];
    if (w === null || cv === null) return null;
    let s = 0;
    if (cv >= w) s++;
    if (up3[si][t] === 1) s++;
    const pos = vwaps[si].pos[t];
    if (pos !== null && pos <= 8) s++;
    return s;
  })));
  // allow_long = 站上VWAP20 且 VWAP20 上行；entry_signal = 当日由线下上穿且VWAP三日上斜
  fields.set("allow_long", symbols.map((_, si) => vwaps[si].vwap.map((w, t) => {
    const cv = cArr[si][t];
    return w === null || cv === null ? null : (cv >= w && up3[si][t] === 1 ? 1 : 0);
  })));
  fields.set("entry_signal", symbols.map((_, si) => vwaps[si].vwap.map((w, t) => {
    const cv = cArr[si][t], pw = t > 0 ? vwaps[si].vwap[t - 1] : null, pc = t > 0 ? cArr[si][t - 1] : null;
    const sl = vwapSlope3[si][t];
    return w === null || cv === null || pw === null || pc === null ? null : (pc < pw && cv >= w && sl !== null && sl > 0 ? 1 : 0);
  })));

  // 缠论（分型 + 简化中枢）
  const fractals = symbols.map((_, si) => chanFractalFlags(h[si], l[si]));
  fields.set("chan_top_fractal", fractals.map((m) => m.top));
  fields.set("chan_bottom_fractal", fractals.map((m) => m.bottom));
  const zhongshu = symbols.map((_, si) => chanZhongshuSignals(h[si], l[si], cArr[si], oArr[si]));
  fields.set("cz_break_up", zhongshu.map((m) => m.breakUp));
  fields.set("cz_break_down", zhongshu.map((m) => m.breakDown));
  fields.set("chan_third_buy", zhongshu.map((m) => m.thirdBuy));
  fields.set("chan_third_sell", zhongshu.map((m) => m.thirdSell));

  // TD序列
  const tds = symbols.map((_, si) => tdSeq(h[si], l[si], cArr[si]));
  fields.set("td_buy_seq", tds.map((m) => m.buy));
  fields.set("td_sell_seq", tds.map((m) => m.sell));
  fields.set("td_signal", tds.map((m) => m.signal));
  fields.set("td13_buy_qualified", tds.map((m) => m.buy13q));
  fields.set("td13_sell_qualified", tds.map((m) => m.sell13q));

  // 江恩
  const ganns = symbols.map((_, si) => gannSupportSig(h[si], l[si], cArr[si], oArr[si]));
  fields.set("gann_support_sig_1_1", ganns.map((m) => m.sig11));
  fields.set("gann_support_sig_1_2", ganns.map((m) => m.sig12));
  fields.set("gann_support_sig_2_1", ganns.map((m) => m.sig21));

  // 高斯通道
  const gausses = symbols.map((_, si) => gaussChannel(cArr[si]));
  fields.set("gauss_mid", gausses.map((m) => m.mid));
  fields.set("gauss_upper", gausses.map((m) => m.upper));
  fields.set("gauss_lower", gausses.map((m) => m.lower));
  const gaussUp = gausses.map((m) => m.mid.map((v, t) => {
    const p = t >= 3 ? m.mid[t - 3] : null;
    return v !== null && p !== null ? (v > p ? 1 : 0) : null;
  }));
  fields.set("gauss_trend_up", gaussUp);
  fields.set("gauss_trend_flip_up", gaussUp.map((s) => s.map((x, t) => (t > 0 && x === 1 && s[t - 1] === 0 ? 1 : 0))));
  fields.set("gauss_trend_flip_down", gaussUp.map((s) => s.map((x, t) => (t > 0 && x === 0 && s[t - 1] === 1 ? 1 : 0))));
  fields.set("gauss_overheat", symbols.map((_, si) => gausses[si].upper.map((u, t) => {
    const cv = cArr[si][t];
    return u === null || cv === null ? null : (cv > u ? 1 : 0);
  })));

  // 支撑阻力（近端高低点近似）
  const hh = (series: Series, n: number): Series => series.map((_, t) => {
    if (t < n - 1) return null;
    let m = -Infinity;
    for (let i = t - n + 1; i <= t; i++) { const val = series[i]; if (val === null) return null; if (val > m) m = val; }
    return m;
  });
  const hh20 = symbols.map((_, si) => hh(h[si], 20));
  const hh60 = symbols.map((_, si) => hh(h[si], 60));
  fields.set("breakout_high_20", symbols.map((_, si) =>
    hh20[si].map((m, t) => (m !== null && cArr[si][t] !== null ? (cArr[si][t]! >= m ? 1 : 0) : null))));
  fields.set("breakout_high_60", symbols.map((_, si) =>
    hh60[si].map((m, t) => (m !== null && cArr[si][t] !== null ? (cArr[si][t]! >= m ? 1 : 0) : null))));

  // ---------- 庄家宝体系（zsb）：严格按通达信原始公式，SMA 口径=tdxSma/kdjCalc 递归 ----------
  const zsbDealer: Series[] = [], zsbRetail: Series[] = [], zsbRsiV: Series[] = [];
  const zsbAccum: Series[] = [], zsbAttack: Series[] = [], zsbTrigger: Series[] = [];
  const zsbReduce: Series[] = [], zsbBdw: Series[] = [];
  for (let si = 0; si < symbols.length; si++) {
    const c = cArr[si];
    const dealer = dealerCalc(h[si], l[si], c);               // EMA(J(81日RSV),6)
    const retail = retailCalc(h[si], l[si], c, ZSB_RETAIL_M); // M=34 固定
    const rsiV = rsiVCalc(v[si], ZSB_RSI_V_N);                // N 参数化（默认14，pending）
    const kp = kongpanCalc(c);                                 // 纯价格「控盘」中间量
    const bar = macds[si].bar;                                 // acc_macd 与现有 MACD 柱口径一致（2*(DIF-DEA)），复用
    const cross = crossUp(dealer, retail);                     // CROSS(庄家,散户)
    const accum: Series = new Array(T).fill(null);
    for (let t = 0; t < T; t++) {
      const b = bar[t], pb = t > 0 ? bar[t - 1] : null, k = kp[t];
      accum[t] = b !== null && pb !== null && k !== null ? (b > 0 && pb <= 0 && k > 0 ? 1 : 0) : null;
    }
    const attack: Series = new Array(T).fill(null);
    for (let t = 0; t < T; t++) {
      const rv = rsiV[t], d = dealer[t], r = retail[t], k = kp[t];
      attack[t] = rv !== null && d !== null && r !== null && k !== null
        ? (rv >= 50 && d > r && k > 0 ? 1 : 0) : null;
    }
    const trigger: Series = new Array(T).fill(null);
    for (let t = 0; t < T; t++) {
      const x = cross[t], a = accum[t], vol = v[si][t], mv = vma5[si][t];
      trigger[t] = x !== null && a !== null && vol !== null && mv !== null && mv > 0
        ? (x === 1 && a === 1 && vol > mv ? 1 : 0) : null;
    }
    const reduce: Series = new Array(T).fill(null);
    for (let t = 0; t < T; t++) {
      const rv = rsiV[t], prev = t > 0 ? rsiV[t - 1] : null;
      reduce[t] = rv !== null && prev !== null ? (rv >= 80 && rv < prev ? 1 : 0) : null;
    }
    zsbDealer.push(dealer); zsbRetail.push(retail); zsbRsiV.push(rsiV);
    zsbAccum.push(accum); zsbAttack.push(attack); zsbTrigger.push(trigger);
    zsbReduce.push(reduce); zsbBdw.push(bdwCalc(c, v[si], ZSB_BDW_N));
  }
  fields.set("zsb_dealer", zsbDealer);
  fields.set("zsb_retail", zsbRetail);
  fields.set("zsb_rsi_v", zsbRsiV);
  fields.set("acc_dif", macds.map((m) => m.dif)); // 与现有 macd_dif 同一序列：公式一致（EMA12-EMA26），复用不重算
  fields.set("acc_dea", macds.map((m) => m.dea));
  fields.set("acc_macd", macds.map((m) => m.bar));
  fields.set("zsb_accum", zsbAccum);
  fields.set("zsb_attack", zsbAttack);
  fields.set("zsb_trigger", zsbTrigger);
  fields.set("zsb_rsi_reduce", zsbReduce);
  fields.set("zsb_bdw", zsbBdw);

  // 支撑阻力信号（任务C：线=滚动N日 低/高（不含当日 t-N..t-1）；突破须发生「上穿」事件）
  const rollLo = (series: Series, n: number): Series => series.map((_, t) => {
    if (t < n) return null;
    let m = Infinity;
    for (let i = t - n; i <= t - 1; i++) { const val = series[i]; if (val === null) return null; if (val < m) m = val; }
    return m;
  });
  const rollMax = (series: Series, n: number): Series => series.map((_, t) => {
    if (t < n) return null;
    let m = -Infinity;
    for (let i = t - n; i <= t - 1; i++) { const val = series[i]; if (val === null) return null; if (val > m) m = val; }
    return m;
  });
  for (const n of [60, 144]) {
    const sup = symbols.map((_, si) => rollLo(l[si], n));
    const resN = symbols.map((_, si) => rollMax(h[si], n));
    fields.set(`support_near_${n}`, symbols.map((_, si) => sup[si].map((s, t) => {
      const cv = cArr[si][t];
      return s === null || cv === null ? null : (cv >= s && ((cv - s) / s) * 100 <= 3 ? 1 : 0);
    })));
    fields.set(`support_bounce_${n}`, symbols.map((_, si) => sup[si].map((s, t) => {
      const cv = cArr[si][t], lv = l[si][t], ov = oArr[si][t];
      return s === null || cv === null || lv === null || ov === null ? null : (lv <= s * 1.01 && cv > ov && cv >= s * 1.02 ? 1 : 0);
    })));
    fields.set(`resistance_breakout_${n}`, symbols.map((_, si) => resN[si].map((r, t) => {
      const cv = cArr[si][t];
      const prevC = t > 0 ? cArr[si][t - 1] : null;
      const prevR = t > 0 ? resN[si][t - 1] : null;
      return r === null || cv === null || prevC === null || prevR === null ? null : (cv > r && prevC <= prevR ? 1 : 0);
    })));
  }

  // ---------- P2 剩余因子包接线（任务书 2026-09-19；口径见各 DEFS 注释） ----------
  const vma20 = v.map((s) => sma(s, 20));
  // VWAP 体系
  fields.set("vwap30", symbols.map((_, si) => vwapCalc(cArr[si], v[si], amt[si], 30).vwap));
  fields.set("market_cost_60", symbols.map((_, si) => vwapCalc(cArr[si], v[si], amt[si], 60).vwap));
  const vwapFulls = symbols.map((_, si) => vwapFullCalc(v[si], amt[si]));
  fields.set("vwap_full", vwapFulls);
  const vfSlope3 = vwapFulls.map((s) => pctChange(s, 3));
  fields.set("vwap_slope3", vfSlope3);
  fields.set("vwap_slope6", vwapFulls.map((s) => pctChange(s, 6)));
  fields.set("vwap_accel", vfSlope3.map((s) => pctChange(s, 3)));
  const vw20 = vwaps.map((m) => m.vwap);
  fields.set("vwap_lowpullback", symbols.map((_, si) => vw20[si].map((w, t) => {
    const cv = cArr[si][t], pw = t > 0 ? vw20[si][t - 1] : null, vol = v[si][t], mv = vma20[si][t];
    return cv === null || w === null || pw === null || vol === null || mv === null || mv <= 0 ? null
      : (cv < pw && cv > w && vol > mv ? 1 : 0);
  })));
  fields.set("vwap_break_expand", symbols.map((_, si) => vw20[si].map((w, t) => {
    const cv = cArr[si][t], pw = t > 0 ? vw20[si][t - 1] : null, vol = v[si][t], mv = vma20[si][t];
    return cv === null || pw === null || vol === null || mv === null || mv <= 0 ? null
      : (cv > pw && vol > mv * 1.5 ? 1 : 0);
  })));
  // 高斯通道信号
  fields.set("gauss_entry", symbols.map((_, si) => crossUp(cArr[si], gausses[si].mid)));
  fields.set("gauss_exit", symbols.map((_, si) => crossUp(gausses[si].mid, cArr[si])));
  fields.set("gauss_overheat_warn", symbols.map((_, si) => gausses[si].upper.map((u, t) => {
    const cv = cArr[si][t], vol = v[si][t], mv = vma20[si][t];
    return u === null || cv === null || vol === null || mv === null || mv <= 0 ? null
      : (cv >= u && vol > mv * 1.5 ? 1 : 0);
  })));
  // 缠论简化中枢（10日区间）
  const cz10 = symbols.map((_, si) => czRangeSignals(h[si], l[si], cArr[si], 10));
  fields.set("cz_active", cz10.map((m) => m.active));
  fields.set("cz_start", cz10.map((m) => m.start));
  fields.set("cz_end", cz10.map((m) => m.end));
  fields.set("cz_inside", cz10.map((m) => m.inside));
  // 支撑压力 250/144 变体（线值=含当日字面；信号线=不含当日标准口径）
  fields.set("support_line_250", symbols.map((_, si) => llv(l[si], 250)));
  fields.set("resistance_line_250", symbols.map((_, si) => hhv(h[si], 250)));
  fields.set("support_144_val", symbols.map((_, si) => llv(l[si], 144)));
  fields.set("resistance_144_val", symbols.map((_, si) => hhv(h[si], 144)));
  const sr250 = symbols.map((_, si) => srSignals(h[si], l[si], cArr[si], v[si], 250, vma20[si]));
  fields.set("support_bounce_250", sr250.map((m) => m.bounce));
  fields.set("resistance_rebound_250", sr250.map((m) => m.rebound));
  fields.set("support_break_250", sr250.map((m) => m.supportBreak));
  fields.set("resistance_breakout_250", sr250.map((m) => m.resistanceBreakoutVol));
  fields.set("support_near_250", sr250.map((m) => m.supportNear));
  fields.set("resistance_near_250", sr250.map((m) => m.resistanceNear));
  fields.set("support_breakdown_250", sr250.map((m) => m.supportBreakdown2));
  fields.set("resistance_breakout_250_conf", sr250.map((m) => m.resistanceBreakoutConf2));
  // 其他
  fields.set("vol_spike_ratio", symbols.map((_, si) => v[si].map((x, t) => {
    const mv = vma20[si][t];
    return x !== null && mv !== null && mv > 0 ? x / mv : null;
  })));
  fields.set("close_dev_ma120", cArr.map((s) => {
    const m = sma(s, 120);
    return m.map((mv, t) => (mv !== null && s[t] !== null && mv > 0 ? (s[t]! / mv - 1) * 100 : null));
  }));
  const amp20H = symbols.map((_, si) => hhv(h[si], 20));
  const amp20L = symbols.map((_, si) => llv(l[si], 20));
  fields.set("amplitude_20d", symbols.map((_, si) => amp20H[si].map((hv, t) => {
    const lv = amp20L[si][t];
    return hv !== null && lv !== null && lv > 0 ? (hv - lv) / lv * 100 : null;
  })));

  // RPS（子集截面百分位：N日涨幅在子集内的排名百分位；口径=K线子集，非全A）
  const rocN = (n: number): Series[] => cArr.map((s) =>
    s.map((v, t) => (t >= n && s[t - n] !== null && s[t - n]! > 0 && v !== null ? (v / s[t - n]! - 1) * 100 : null)));
  const rpsOf = (n: number): Series[] => {
    const roc = rocN(n);
    const out: Series[] = symbols.map(() => new Array(T).fill(null));
    for (let t = 0; t < T; t++) {
      const col: { si: number; v: number }[] = [];
      for (let si = 0; si < symbols.length; si++) { const val = roc[si][t]; if (val !== null) col.push({ si, v: val }); }
      if (col.length < 10) continue;
      col.sort((a, b) => a.v - b.v);
      col.forEach((p, r) => { out[p.si][t] = (r / (col.length - 1)) * 100; });
    }
    return out;
  };
  const rps50 = rpsOf(50), rps120 = rpsOf(120);
  fields.set("rps_50", rps50);
  fields.set("rps_120", rps120);
  fields.set("rps_composite", symbols.map((_, si) =>
    rps50[si].map((a, t) => (a !== null && rps120[si][t] !== null ? (a + rps120[si][t]!) / 2 : null))));

  return { dates, symbols, fields };
}

// 每只股票每个字段「最后一根有效值」
export function lastValues(panel: KPanel): Map<string, Map<string, number | null>> {
  const out = new Map<string, Map<string, number | null>>();
  panel.fields.forEach((rows, key) => {
    rows.forEach((series, si) => {
      let m = out.get(panel.symbols[si]);
      if (!m) { m = new Map(); out.set(panel.symbols[si], m); }
      let v: number | null = null;
      for (let t = series.length - 1; t >= 0; t--) { if (series[t] !== null) { v = series[t]; break; } }
      m.set(key, v);
    });
  });
  return out;
}
