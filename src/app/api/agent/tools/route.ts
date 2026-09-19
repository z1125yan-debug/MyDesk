// GET /api/agent/tools — Agent 工具目录（P6-D）
//
// 这一页只回答「Agent 能调哪些工具、每条从哪来、参数怎么给、哪些明确不给跑」。
// 全部字段派生自内核（agent-tools-core.ts 的工具表 + agent-loop-core.ts 的预算），
// 本路由不另立一份工具清单：另立一份就会有两套口径，而 §二十六 禁止的正是「再造一套相同工具」。
//
// 口径要点（页面必须照这些说）：
// - 工具在表里 ≠ 这次取到数据：可用与否只是「这条路存在」，实际结果以每次调用的日志为准；
// - enabled=false 的工具带 disabledReason：不开放也要说清原因，静默消失等于伪装成可用；
// - unimplemented_executors：登记表声明了执行器但服务层没有分支 ⇒ 直接点名（这是「假能力」，不能不报）。
import { NextResponse } from "next/server";
import { quantBootstrap } from "@/lib/quant/bootstrap";
import { BUDGET_HARD_CAPS, DEFAULT_AGENT_BUDGET, agentToolSummary } from "@/lib/quant/screener/agent-loop-core";
import {
  TOOL_DEFS, agentToolBasis, disabledTools, enabledTools, readOnlyViolations, unsupportedToolReason,
} from "@/lib/quant/screener/agent-tools-core";

export const dynamic = "force-dynamic";

export async function GET() {
  quantBootstrap();
  try {
    // 执行器覆盖自检在服务层（要 import 取数实现），所以动态加载：目录页不必为它常驻整个 provider 链
    const { unimplementedExecutors } = await import("@/lib/quant/screener/agent-tools");
    const sum = agentToolSummary();
    const unimplemented = unimplementedExecutors();
    const violations = readOnlyViolations();
    return NextResponse.json({
      ok: true, error: null,
      total: TOOL_DEFS.length,
      enabled: enabledTools().length,
      disabled: disabledTools().length,
      tools: TOOL_DEFS.map((t) => ({
        name: t.name, title: t.title, description: t.description,
        capability: t.capability, group: t.group, executor: t.executor,
        input_schema: t.inputSchema, input_note: t.inputNote, output_schema: t.outputSchema,
        source: t.source, source_type: t.source_type, freshness: t.freshness, data_status: t.data_status,
        availability: t.availability, risk_level: t.riskLevel, side_effect: t.sideEffect,
        enabled: t.enabled, fallbacks: t.fallbacks, limitations: t.limitations, examples: t.examples,
        timeout_ms: t.timeout_ms,
        // 不可执行的条目把原因带在行上：页面不需要再查一次表才知道它为什么不能跑
        disabled_reason: t.enabled ? null : unsupportedToolReason(t.name),
      })),
      catalog_text: sum.text,
      budget: { default: DEFAULT_AGENT_BUDGET, hard_caps: BUDGET_HARD_CAPS },
      self_check: {
        unimplemented_executors: unimplemented,
        read_only_violations: violations,
      },
      basis: agentToolBasis(),
    });
  } catch (e) {
    // 错误结构与成功时同名同形（§三十一），页面按 error 原文显示即可
    return NextResponse.json({
      ok: false, error: `工具目录读取失败：${(e as Error).message}`,
      total: 0, enabled: 0, disabled: 0, tools: [], catalog_text: "",
      budget: { default: DEFAULT_AGENT_BUDGET, hard_caps: BUDGET_HARD_CAPS },
      self_check: { unimplemented_executors: [], read_only_violations: [] },
      basis: "本层没有读执行器：目录本身来自内核，取数实现加载失败不影响「有哪些工具」这件事",
    }, { status: 502 });
  }
}
