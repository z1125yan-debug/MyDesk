// 板块 → 产业链环节 / 板块基本面（本地快照，服务端）。Serenity 补数层（2026-09-29 第二轮）。
//
// 为什么需要它：六问第 2 步要「链上位置」、第 3/4 步要「公司暴露度与利润捕获」，
// 而此前模型只能拿到板块名 + 涨幅 + 净额，于是「该板块内 AI 相关子行业是哪些」「板块整体市值多少」
// 「板块的利润/订单/存货/资本开支变化」全被写成「暂无数据」——但这些本仓**本地就有**：
//   - data/sector-industry-map.json   槽位①：板块 → 产业链节点（上/中/下游，带域），35 个板块有映射；
//                                     槽位②：节点级月度指标（价格/库存/资本开支等，长表）；
//   - data/sector-fundamentals.json   板块财务分量（利润/订单/存货/资本开支同比，来自 MCP 三表聚合）。
// 「板块风险」页早就用同一份文件做产业链诊断，这里只是把同一份数据接到对话链路。
//
// 口径纪律：
// 1) 只读本地文件（mtime 缓存），不发上游请求；
// 2) 板块名**精确匹配**；查不到返回 null（如实露缺），不拿相近板块硬凑；
// 3) 返回值必须自带 `口径`，说清它是什么（产业链节点清单 / 快照财务），别让模型把它当实时行情。
import fs from "fs";
import path from "path";

const MAP_FILE = path.join(process.cwd(), "data", "sector-industry-map.json");
const FUND_FILE = path.join(process.cwd(), "data", "sector-fundamentals.json");

export interface ChainNode {
  nodeId: string;
  name: string;
  layer: string;
  domain: string;
}
interface MapJson {
  generatedAt: string;
  source: string;
  note: string;
  industryNodes: Record<string, ChainNode>;
  sectorIndustryMap: Record<string, { nodeId: string; role: string }[]>;
  metricSnapshots: Record<string, { date: string; metric: string; value: number | string; unit?: string; proxy_note?: string }[]>;
}
interface FundJson {
  generatedAt: string;
  source: string;
  frequency?: string;
  sectors: Record<string, Record<string, unknown>>;
}

function loadWithMtime<T>(file: string, holder: { v: T | null; m: number }): T | null {
  try {
    const st = fs.statSync(file);
    if (holder.v && holder.m === st.mtimeMs) return holder.v;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as T;
    holder.v = parsed;
    holder.m = st.mtimeMs;
    return parsed;
  } catch {
    return null;
  }
}
const mapHolder: { v: MapJson | null; m: number } = { v: null, m: 0 };
const fundHolder: { v: FundJson | null; m: number } = { v: null, m: 0 };

/** 产业链映射表 / 板块财务快照的生成时点（返回值里要如实标出，模型据此判断新鲜度） */
export function sectorChainMeta(): { chainGeneratedAt: string | null; fundGeneratedAt: string | null; mappedSectorCount: number } {
  const m = loadWithMtime<MapJson>(MAP_FILE, mapHolder);
  const f = loadWithMtime<FundJson>(FUND_FILE, fundHolder);
  return {
    chainGeneratedAt: m?.generatedAt ?? null,
    fundGeneratedAt: f?.generatedAt ?? null,
    mappedSectorCount: m ? Object.keys(m.sectorIndustryMap ?? {}).length : 0,
  };
}

/** 板块名是否有产业链映射（服务层判断「本地认不认这个板块的链」用得上） */
export function hasChainMapping(name: string): boolean {
  const m = loadWithMtime<MapJson>(MAP_FILE, mapHolder);
  if (!m?.sectorIndustryMap) return false;
  return Array.isArray(m.sectorIndustryMap[String(name ?? "").trim()]);
}

/** 取某节点的最新月度指标（每个 metric 取最近一条；长表 → 短表） */
function latestMetricsOf(m: MapJson, nodeId: string): { 指标: string; 值: number | string; 单位?: string; 期间: string; 备注?: string }[] {
  const rows = m.metricSnapshots?.[nodeId];
  if (!Array.isArray(rows) || !rows.length) return [];
  const lastByMetric = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = lastByMetric.get(r.metric);
    if (!cur || String(r.date) > String(cur.date)) lastByMetric.set(r.metric, r);
  }
  return [...lastByMetric.values()]
    .sort((a, b) => String(a.metric).localeCompare(String(b.metric)))
    .map((r) => ({
      指标: r.metric,
      值: r.value,
      ...(r.unit ? { 单位: r.unit } : {}),
      期间: r.date,
      ...(r.proxy_note ? { 备注: r.proxy_note } : {}),
    }));
}

/**
 * 板块 → 产业链环节（按上/中/下游分组）。
 * 查不到映射返回 null（例如申报口径不同、或该板块未纳入 35 个映射板块）。
 */
export function chainOfSector(name: string): {
  domain: string | null;
  上游: unknown[];
  中游: unknown[];
  下游: unknown[];
  口径: string;
} | null {
  const key = String(name ?? "").trim();
  if (!key) return null;
  const m = loadWithMtime<MapJson>(MAP_FILE, mapHolder);
  if (!m?.sectorIndustryMap) return null;
  const links = m.sectorIndustryMap[key];
  if (!Array.isArray(links) || !links.length) return null;
  const buckets: Record<string, unknown[]> = { 上游: [], 中游: [], 下游: [] };
  const domains = new Set<string>();
  for (const l of links) {
    const node = m.industryNodes?.[l.nodeId];
    if (!node) continue;
    domains.add(node.domain);
    const bucket = buckets[l.role] ? l.role : (node.layer || "中游");
    (buckets[bucket] ||= []).push({
      节点ID: node.nodeId,
      节点: node.name,
      所属域: node.domain,
      层级: node.layer,
      ...(latestMetricsOf(m, l.nodeId).length ? { 节点月度指标: latestMetricsOf(m, l.nodeId) } : { 节点月度指标: null }),
    });
  }
  return {
    domain: domains.size ? [...domains].join("/") : null,
    上游: buckets.上游,
    中游: buckets.中游,
    下游: buckets.下游,
    口径: "板块→产业链节点映射（结构化领域知识，非 AI 生成；节点月度指标为月度快照，不是实时行情）",
  };
}

/**
 * 板块财务分量（利润 / 订单 / 存货 / 资本开支同比，来自 MCP 三表聚合的板块快照）。
 * 查不到返回 null。**注意口径**：这是按板块聚合的财报口径，不是市值加权，也不是实时数据。
 */
export function fundamentalsOfSector(name: string): Record<string, unknown> | null {
  const key = String(name ?? "").trim();
  if (!key) return null;
  const f = loadWithMtime<FundJson>(FUND_FILE, fundHolder);
  const row = f?.sectors?.[key];
  if (!row || typeof row !== "object") return null;
  return {
    ...row,
    口径: `板块财务分量（按板块内已披露个股聚合，非市值加权；截至最新报告期，数据频度=${f?.frequency ?? "季度"}，生成于 ${String(f?.generatedAt ?? "").slice(0, 10)}）`,
  };
}
