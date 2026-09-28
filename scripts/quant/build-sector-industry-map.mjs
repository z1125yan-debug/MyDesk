// T5 — 板块→产业链映射（v5 新增 · 结构化 · 非 AI 猜）
//
// 产出 data/sector-industry-map.json，对应方案 §0.6 / §6.5 的三张表：
//   industry_node           -> out.industryNodes (node_id, name, layer, domain, parent)
//   sector_industry_map     -> out.sectorIndustryMap (sector -> [{nodeId, role}])  多对多
//   industry_metric_snapshot-> out.metricSnapshots (Phase2 数据源回补；当前空，引擎标注「产业层数据不足」降权)
//
// 映射键使用申万二级行业真实名（与 data/sector-constituents.json 的 89 行业一致），
// 扫描器对任意板块都能据此自动对应产业、节点级聚合，不靠 AI 猜。
// 8 个优先板块（半导体/AI算力/新能源/医药/汽车/房地产/有色/化工）做丰富节点树覆盖。

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, "data", "sector-industry-map.json");

// ── 1. 领域 → 节点树（上游/中游/下游）──────────────────────────────
const DOMAINS = {
  semi: {
    name: "半导体",
    nodes: [
      { id: "semi_wafer", name: "硅片", layer: "上游" },
      { id: "semi_resist", name: "光刻胶", layer: "上游" },
      { id: "semi_gas", name: "电子特气", layer: "上游" },
      { id: "semi_material", name: "半导体材料", layer: "上游" },
      { id: "semi_design", name: "芯片设计", layer: "中游" },
      { id: "semi_fab", name: "晶圆制造", layer: "中游" },
      { id: "semi_osat", name: "封装测试", layer: "中游" },
      { id: "semi_equip", name: "半导体设备", layer: "中游" },
      { id: "semi_ai_server", name: "AI服务器", layer: "下游" },
      { id: "semi_phone", name: "智能手机", layer: "下游" },
      { id: "semi_auto_elec", name: "汽车电子", layer: "下游" },
      { id: "semi_consumer", name: "消费电子", layer: "下游" },
    ],
  },
  ai: {
    name: "AI算力",
    nodes: [
      { id: "ai_hbm", name: "HBM存储", layer: "上游" },
      { id: "ai_gpu", name: "GPU/算力芯片", layer: "中游" },
      { id: "ai_server", name: "服务器", layer: "中游" },
      { id: "ai_optical_module", name: "光模块", layer: "中游" },
      { id: "ai_pcb", name: "PCB/CCL", layer: "中游" },
      { id: "ai_cooling", name: "液冷", layer: "中游" },
      { id: "ai_datacenter", name: "数据中心/IDC", layer: "下游" },
    ],
  },
  newenergy: {
    name: "新能源",
    nodes: [
      { id: "ne_lithium", name: "锂矿/锂盐", layer: "上游" },
      { id: "ne_polysilicon", name: "硅料", layer: "上游" },
      { id: "ne_battery", name: "锂电池", layer: "中游" },
      { id: "ne_cell", name: "电芯/储能", layer: "中游" },
      { id: "ne_pv", name: "光伏组件", layer: "中游" },
      { id: "ne_wind", name: "风电整机", layer: "中游" },
      { id: "ne_ev", name: "新能源车", layer: "下游" },
      { id: "ne_grid", name: "电网/储能系统", layer: "下游" },
    ],
  },
  pharma: {
    name: "医药",
    nodes: [
      { id: "ph_api", name: "原料药", layer: "上游" },
      { id: "ph_chemical", name: "化学制药", layer: "中游" },
      { id: "ph_tcm", name: "中药", layer: "中游" },
      { id: "ph_bio", name: "生物制品/创新药", layer: "中游" },
      { id: "ph_device", name: "医疗器械", layer: "中游" },
      { id: "ph_cxo", name: "CXO", layer: "中游" },
      { id: "ph_service", name: "医疗服务", layer: "下游" },
      { id: "ph_retail", name: "医药商业/药店", layer: "下游" },
    ],
  },
  auto: {
    name: "汽车",
    nodes: [
      { id: "auto_oem", name: "整车制造", layer: "中游" },
      { id: "auto_parts", name: "零部件", layer: "中游" },
      { id: "auto_battery", name: "车用动力电池", layer: "中游" },
      { id: "auto_smart", name: "智能驾驶", layer: "中游" },
      { id: "auto_sales", name: "汽车销售/库存", layer: "下游" },
    ],
  },
  re: {
    name: "房地产",
    nodes: [
      { id: "re_land", name: "土地/新开工", layer: "上游" },
      { id: "re_material", name: "建材", layer: "上游" },
      { id: "re_develop", name: "房地产开发", layer: "中游" },
      { id: "re_property", name: "物业服务", layer: "下游" },
      { id: "re_home", name: "家居", layer: "下游" },
    ],
  },
  metal: {
    name: "有色",
    nodes: [
      { id: "mt_cu", name: "铜", layer: "上游" },
      { id: "mt_al", name: "铝", layer: "上游" },
      { id: "mt_gold", name: "黄金/贵金属", layer: "上游" },
      { id: "mt_small", name: "小金属", layer: "上游" },
      { id: "mt_energy", name: "能源金属(锂钴镍)", layer: "上游" },
      { id: "mt_process", name: "加工费/冶炼", layer: "中游" },
    ],
  },
  chem: {
    name: "化工",
    nodes: [
      { id: "ch_basic", name: "基础化工", layer: "上游" },
      { id: "ch_fiber", name: "化纤", layer: "中游" },
      { id: "ch_agro", name: "农化(化肥/农药)", layer: "中游" },
      { id: "ch_specialty", name: "精细化工/新材料", layer: "中游" },
      { id: "ch_plastic", name: "塑料/橡胶", layer: "下游" },
    ],
  },
};

// ── 2. 申万行业(真实名) → 节点（多对多）───────────────────────────
// 同一节点可被多个板块引用（如 光模块 → 通信设备 + AI算力 + 数据中心）。
const SECTOR_MAP = {
  半导体: ["semi_wafer", "semi_resist", "semi_gas", "semi_material", "semi_design", "semi_fab", "semi_osat", "semi_equip", "semi_ai_server", "semi_phone", "semi_auto_elec", "semi_consumer"],
  通信设备: ["ai_optical_module", "ai_pcb", "ai_datacenter", "ai_cooling"],
  计算机设备: ["ai_gpu", "ai_server", "ai_datacenter"],
  元件: ["ai_pcb"],
  消费电子: ["semi_phone", "semi_consumer", "semi_ai_server"],
  通信服务: ["ai_datacenter"],

  电池: ["ne_lithium", "ne_battery", "ne_cell", "auto_battery"],
  光伏设备: ["ne_polysilicon", "ne_pv"],
  风电设备: ["ne_wind"],
  能源金属: ["ne_lithium", "mt_energy"],
  电网设备: ["ne_cell", "ne_grid"],
  其他电源设备: ["ne_grid", "ne_cell"],

  化学制药: ["ph_api", "ph_chemical"],
  中药: ["ph_tcm"],
  生物制品: ["ph_bio"],
  医疗器械: ["ph_device"],
  医疗服务: ["ph_service"],
  医药商业: ["ph_retail"],

  汽车整车: ["auto_oem", "auto_battery", "auto_smart", "auto_sales"],
  汽车零部件: ["auto_parts", "auto_smart"],
  汽车服务及其他: ["auto_sales"],

  房地产: ["re_develop", "re_property", "re_land"],
  建筑材料: ["re_material"],
  家居用品: ["re_home"],
  建筑装饰: ["re_material"],

  工业金属: ["mt_cu", "mt_al", "mt_process"],
  小金属: ["mt_small"],
  贵金属: ["mt_gold"],
  金属新材料: ["mt_small"],

  化学原料: ["ch_basic"],
  化学制品: ["ch_specialty", "ch_basic"],
  化学纤维: ["ch_fiber"],
  农化制品: ["ch_agro"],
  塑料制品: ["ch_plastic"],
  橡胶制品: ["ch_plastic"],
};

// ── 3. 组装 ───────────────────────────────────────────────────────
const industryNodes = {};
for (const [domainKey, d] of Object.entries(DOMAINS)) {
  for (const n of d.nodes) {
    industryNodes[n.id] = {
      nodeId: n.id,
      name: n.name,
      layer: n.layer,
      domain: d.name,
      parent: null,
    };
  }
}

// 校验：SECTOR_MAP 引用的 nodeId 必须存在
const missing = [];
for (const [sector, ids] of Object.entries(SECTOR_MAP)) {
  for (const id of ids) if (!industryNodes[id]) missing.push(`${sector} -> ${id}`);
}
if (missing.length) {
  console.error("❌ 引用了不存在的 nodeId：\n  " + missing.join("\n  "));
  process.exit(1);
}

const sectorIndustryMap = {};
for (const [sector, ids] of Object.entries(SECTOR_MAP)) {
  sectorIndustryMap[sector] = ids.map((id) => ({
    nodeId: id,
    role: industryNodes[id].layer, // 上游/中游/下游
  }));
}

const out = {
  generatedAt: new Date().toISOString(),
  source: "结构化领域知识（非AI生成，v5 §0.6/§6.5）",
  layers: ["上游", "中游", "下游"],
  note: "板块→产业链映射为结构化基础设施；扫描器对任意申万板块按 sectorIndustryMap 自动对应产业节点并聚合。industry_metric_snapshot(节点级月度快照)由 Phase2 数据源(akshare/SMM/生意社/NBS/PMI)回补；当前为空 → 引擎标注「产业层数据不足」并降权，不硬编、不靠模型猜。",
  domainCount: Object.keys(DOMAINS).length,
  nodeCount: Object.keys(industryNodes).length,
  mappedSectorCount: Object.keys(sectorIndustryMap).length,
  industryNodes,
  sectorIndustryMap,
  metricSnapshotTemplate: {
    fields: ["orders_z", "inventory_state", "price_trend", "earnings_z", "capex_state"],
    enums: {
      inventory_state: ["去库存", "库存低位", "补库存", "主动补库", "库存高位", "被动累库"],
      price_trend: ["上行", "平稳", "下行"],
      capex_state: ["收缩", "平稳", "扩张"],
    },
    note: "节点级月度快照；orders_z/earnings_z 为 z-score(标准化)，其余为枚举。Phase2 回补。",
  },
  metricSnapshots: {}, // nodeId -> [ {date, orders_z, inventory_state, price_trend, earnings_z, capex_state} ]
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");

// 汇总
const byLayer = { 上游: 0, 中游: 0, 下游: 0 };
for (const n of Object.values(industryNodes)) byLayer[n.layer]++;
console.log(`✅ 写入 ${OUT}`);
console.log(`   领域 ${out.domainCount} 个 / 节点 ${out.nodeCount} 个 (上游${byLayer["上游"]}·中游${byLayer["中游"]}·下游${byLayer["下游"]}) / 已映射申万板块 ${out.mappedSectorCount} 个`);
console.log(`   反向多对多示例：光模块 被引用 ${Object.values(sectorIndustryMap).filter((a) => a.some((x) => x.nodeId === "ai_optical_module")).length} 个板块`);
