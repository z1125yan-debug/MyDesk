// Quant Research Lab — 研究知识库查询（Phase 10，纯逻辑：把库内容整理成研究上下文）
// Agent 开始新的研究之前必须查询本模块，避免重复已失败的实验。
import type { KnowledgeEntry } from "../types.ts";

export interface ResearchContext {
  validFactors: string[];
  invalidFactors: string[];
  testedParams: string[];
  failedStrategies: string[];
  retiredStrategies: string[];
  marketEnv: string[];
  currentStrategies: string[];
  avoidNotes: string[]; // 明确的"不要重复"清单
  entryCount: number;
}

export function buildResearchContext(entries: KnowledgeEntry[]): ResearchContext {
  const ctx: ResearchContext = {
    validFactors: [], invalidFactors: [], testedParams: [], failedStrategies: [],
    retiredStrategies: [], marketEnv: [], currentStrategies: [], avoidNotes: [],
    entryCount: entries.length,
  };
  for (const e of entries) {
    if (!e.active) continue;
    switch (e.kind) {
      case "valid_factor": ctx.validFactors.push(`${e.title} — ${e.content}`); break;
      case "invalid_factor":
        ctx.invalidFactors.push(`${e.title} — ${e.content}`);
        ctx.avoidNotes.push(`不要重复尝试因子：${e.title}`);
        break;
      case "tested_param":
        ctx.testedParams.push(`${e.title} — ${e.content}`);
        ctx.avoidNotes.push(`不要重复参数实验：${e.title}`);
        break;
      case "failed_strategy":
        ctx.failedStrategies.push(`${e.title} — ${e.content}`);
        ctx.avoidNotes.push(`不要重复策略：${e.title}`);
        break;
      case "retired_strategy":
        ctx.retiredStrategies.push(`${e.title} — ${e.content}`);
        ctx.avoidNotes.push(`已退役策略（除非环境变化）：${e.title}`);
        break;
      case "market_env": ctx.marketEnv.push(`${e.title} — ${e.content}`); break;
      case "current_strategy": ctx.currentStrategies.push(`${e.title} — ${e.content}`); break;
    }
  }
  return ctx;
}

export function contextToPrompt(ctx: ResearchContext): string {
  const lines: string[] = ["【研究知识库上下文】"];
  lines.push(`有效因子（${ctx.validFactors.length}）：${ctx.validFactors.slice(0, 10).join("；") || "无"}`);
  lines.push(`无效因子（${ctx.invalidFactors.length}）：${ctx.invalidFactors.slice(0, 10).join("；") || "无"}`);
  lines.push(`已试参数（${ctx.testedParams.length}）：${ctx.testedParams.slice(0, 10).join("；") || "无"}`);
  lines.push(`失败策略（${ctx.failedStrategies.length}）：${ctx.failedStrategies.slice(0, 10).join("；") || "无"}`);
  lines.push(`退役策略（${ctx.retiredStrategies.length}）：${ctx.retiredStrategies.slice(0, 10).join("；") || "无"}`);
  lines.push(`市场环境备注：${ctx.marketEnv.slice(0, 5).join("；") || "无"}`);
  lines.push(`当前策略：${ctx.currentStrategies.slice(0, 10).join("；") || "无"}`);
  if (ctx.avoidNotes.length) {
    lines.push("【避免重复清单】");
    ctx.avoidNotes.slice(0, 20).forEach((n) => lines.push(`- ${n}`));
  }
  return lines.join("\n");
}
