// GET /api/capabilities/probe — 能力探测：这一次到底取到了没有（P6-A）
//
// 默认只读本地：SQLite 行数/最新日期、验证账本、Provider 注册表、MCP 运行态。
// 带 ?live=1 才真的打上游（固定 7 个小请求：网关报价、腾讯指数价、上证日K、东财板块榜、
// 个股主力资金日K、快讯、代码检索），并且 20 秒内复用上一次结果——「分析市场」不该被一次健康探测打满。
//
// 三条不能糊弄的地方（都写进响应，前端与 Agent 只能照这个说）：
// - probed:false 表示「本次没测」，绝不显示成 MISSING 或 0；
// - request_failed / no_data / not_covered 三种不可用互不合并，各自带原因；
// - scope=channel 只说明同一接口族可达，不表示该能力当场取到了数据。
import { NextResponse } from "next/server";
import { probeCapabilities } from "@/lib/quant/screener/capability-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const live = url.searchParams.get("live") === "1" || url.searchParams.get("live") === "true";
  const force = url.searchParams.get("force") === "1";
  const only = (url.searchParams.get("only") ?? "").trim();
  try {
    const result = await probeCapabilities({ live, force });
    const unusable = result.probes.filter((p) => p.probed && !p.usable);
    // 出参自检：不可用能力的 status 只允许 MISSING / DEGRADED（envelopeOf 已强制，这里再核一遍并如实报告）
    const violations = unusable.filter((p) => p.status !== "MISSING" && p.status !== "DEGRADED").map((p) => `${p.name}:${p.status}`);
    const body: Record<string, unknown> = {
      ...result,
      self_check: {
        rule: "不可用 ⇒ status 只能是 MISSING/DEGRADED；未探测 ⇒ probed:false，不改写登记表声明的分层",
        unusable_statuses: [...new Set(unusable.map((p) => p.status))],
        violations,
      },
    };
    if (only) {
      const picked = result.probes.filter((p) => p.name === only || p.title.includes(only));
      if (!picked.length) {
        return NextResponse.json({
          ok: false,
          error: `探测结果里没有「${only}」这条能力（登记表里不存在该名字，不是取数失败）`,
          names: result.probes.map((p) => p.name),
        }, { status: 404 });
      }
      body.probes = picked;
      body.only = only;
      // counts/layering 仍是整张登记表的口径：不写清楚就会被读成「本次只测了 1 条 ⇒ 其余 39 条不可用」
      body.counts_note = `counts/layering 按全登记表 ${result.counts.total} 条统计，probes 只是过滤后的 ${picked.length} 条；被过滤掉的能力本次没有单独重探（结果仍在缓存里）`;
    }
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ ok: false, error: `能力探测失败：${(e as Error).message}` }, { status: 502 });
  }
}
