// P7-⑩ 任务4：模型通道状态端点。浏览器靠它决定「AI 未配置」的门要不要开、要不要显示
// 「走服务端 .env 通道」。口径与 /api/qimen/chart 一致：GET only、force-dynamic（配置改了
// 刷新即见，不缓存假状态）、不发起任何上游请求（这里只报 .env 解析结果，连网关通不通都不猜，
// 连通性由真实对话请求去证明）。Key 的值永不出现在响应里。
import { NextResponse } from "next/server";
import { getServerLlm } from "@/lib/llm/model-config";

export const dynamic = "force-dynamic";

export async function GET() {
  const r = getServerLlm();
  if (!r.available) {
    return NextResponse.json({ available: false, reason: r.reason });
  }
  return NextResponse.json({
    available: true,
    mode: r.channel.mode,
    baseUrl: r.channel.baseUrl,
    model: r.channel.model,
  });
}
