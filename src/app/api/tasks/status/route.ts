// GET 后台任务运行状态（P2-自动化 13：任务运行记录）
// 回答三个问题：到底有没有运行 / 什么时候运行 / 为什么失败。数据全部来自 task_run 真实行，不做推测。
import { NextResponse } from "next/server";
import { schedulerStatus } from "@/lib/quant/scheduler/index";

export const dynamic = "force-dynamic";

export async function GET() {
  // 失败也必须返回可读 JSON（空 body 会让前端抛 "Unexpected end of JSON input"，掩盖真实原因）
  try {
    return NextResponse.json(await schedulerStatus());
  } catch (e) {
    return NextResponse.json({ ok: false, error: `任务记录读取失败：${(e as Error).message}` }, { status: 502 });
  }
}
