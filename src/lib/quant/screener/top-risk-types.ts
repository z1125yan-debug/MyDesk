// 板块顶部风险 / 回撤性质识别器 —— 纯类型（无 fs，客户端/服务端共用）
// 实现见 top-risk-engine.ts；UI 见 src/components/desk/pages/SectorTopPage.tsx

export type Stage = "趋势内回撤" | "顶部形成中" | "趋势反转" | "下行延续" | "趋势健康";
export type TopType = "A" | "B" | "C" | "D" | null;
export type Tone = "red" | "orange" | "amber" | "green" | "blue";

export interface SectorTopRisk {
  sector: string;
  stage: Stage;
  stageTone: Tone;
  scores: {
    shortPullback: number;
    midTop: number;
    trendDamage: number;
    industryHealth: number | null; // 产业链数据不足 = null
  };
  topType: TopType;
  topTypeLabel: string;
  topTypeNote: string;
  structural: {
    leader: number | null;
    core: number | null;
    second: number | null;
    leadersDecliningPct: number | null;
    coreBreak: boolean;
  };
  position: {
    prevChange5: number | null;
    prevChange20: number | null;
    prevChange60: number | null;
    prevChange120: number | null;
    distFromHigh20: number | null;
    distMA60: number | null;
  };
  signals: { name: string; tone: Tone }[];
  whoDrops: { label: string; v: number | null }[];
  window: string;
  industryChain: {
    matched: string;
    available: boolean;
    nodes: Record<string, { n: string; tone: Tone }[]>;
    metricsAvailable: number;
    financial: {
      earnings_yoy: number | null;
      orders_yoy: number | null;
      inventory_yoy: number | null;
      capex_yoy: number | null;
      period: string | null;
      sampled: number | null;
      total: number | null;
    } | null;
    note: string;
  };
  pro: string[];
  counter: string[];
  conclusion: string;
  delta: { tone: "up_up" | "up" | "flat" | "down" | "down_down"; medianChange: number | null; label: string };
  advPct: number | null;
  medianChange: number | null;
  rsProxy: number | null;
  rawDate: string;
}

export interface SectorRow {
  sector: string;
  stage: Stage;
  stageTone: Tone;
  delta: SectorTopRisk["delta"]["tone"];
  deltaLabel: string;
  shortPullback: number;
  midTop: number;
  trendDamage: number;
  industryHealth: number | null;
}

export interface ScannerResult {
  scanDate: string;
  sectorCount: number;
  statusSummary: { trendBreak: number; topWatch: number; highPullback: number; downtrend: number; healthy: number };
  levels: string[];
  rows: SectorRow[];
  biggestMovers: string[];
}
