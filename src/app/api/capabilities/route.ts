// GET /api/capabilities — 数据能力登记表（纯静态：不探测、不碰网络、不读库）
//
// 回答任务书 §七 的「我现在能查什么」。登记表只列代码里真实存在的路由/引擎；
// 三条「没有可靠来源」的能力（北向净流入、个股公告、板块日K连续强势天数）也在表里并写明原因：
// 让 Agent 知道这条路是死的，省得它反复试。
//
// 「能力存在」≠「此刻取得数据」：后者要看 GET /api/capabilities/probe 同一次返回的 kind。
//
// 查询参数：
//   ?need=板块资金     → 需求 → 候选能力（只给只读能力；匹配不上返回空数组，不猜）
//   ?name=stock_quote  → 单条能力定义 + 兜底链（主源不可用时该换谁；死路明确为空）
import { NextResponse } from "next/server";
import {
  CAPABILITIES, CAPABILITY_NAMES, GROUP_ORDER, capabilitiesAnswer, capabilitiesForNeed, fallbackChain,
  findCapability, needHints, readOnlyCapabilities, registryBasis,
} from "@/lib/quant/screener/capability-core";
import { registryView } from "@/lib/quant/screener/capability-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const need = (url.searchParams.get("need") ?? "").trim();
    const name = (url.searchParams.get("name") ?? "").trim();

    if (name) {
      const cap = findCapability(name);
      if (!cap) {
        // 未知能力名：明确说没登记，并给出可选名字，绝不返回一个「大概像」的能力
        return NextResponse.json({
          ok: false,
          error: `登记表里没有「${name}」这条能力（不是取数失败，是这条路不存在）`,
          known: CAPABILITY_NAMES,
        }, { status: 404 });
      }
      return NextResponse.json({
        ok: true,
        kind: "capability",
        capability: cap,
        fallbacks: fallbackChain(cap.name).map((c) => ({ name: c.name, title: c.title, availability: c.availability })),
        agent_allowed: !cap.mutating,
        agent_note: cap.mutating ? "该能力会改变系统状态（写库/外部执行），不在 Agent 可用范围内" : "只读能力，Agent 可自主选择调用",
      });
    }

    if (need) {
      const hits = capabilitiesForNeed(need);
      const matched = hits.map((h) => findCapability(h.name)!).filter(Boolean);
      return NextResponse.json({
        ok: true,
        kind: "capability_need",
        need,
        matches: matched,
        // 命中了哪些需求词 + 排在前面的是命中词更多的能力（顺序本身带信息）
        hits: hits.map((h) => ({ name: h.name, matched: h.matched })),
        order_note: hits.length > 1 ? "按命中的需求词个数排序：命中多的在前，但不代表它更适合——要看各自 limitations" : "",
        match_note: hits.length
          ? ""
          : `没有任何已登记的只读能力覆盖「${need}」：应作为缺口显式承认，不要换个说法硬凑${needHints(need).length ? `（相近分组仅供参考：${needHints(need).join("、")}）` : ""}`,
        gap_groups: needHints(need),
      });
    }

    const view = registryView();
    return NextResponse.json({
      ok: true,
      kind: "capabilities",
      basis: registryBasis(),
      groups: view.groups,
      group_order: GROUP_ORDER,
      counts: view.counts,
      not_covered: view.not_covered,
      answer: capabilitiesAnswer(),
      read_only_names: readOnlyCapabilities().map((c) => c.name),
      total: CAPABILITIES.length,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `能力登记表读取失败：${(e as Error).message}` }, { status: 500 });
  }
}
