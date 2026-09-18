import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// TradingView 浏览器扩展回传端点（MyDesk 本地回传）
// POST {symbol, interval, chartUrl, note, ts, key}
// GET  -> 最近待分析列表（前端 5 秒轮询）
interface PendingItem {
  id: number;
  symbol?: string;
  interval?: string;
  chartUrl?: string;
  note?: string;
  ts?: number;
}

interface G {
  __mydeskPending?: PendingItem[];
}
const g = globalThis as unknown as G;
if (!g.__mydeskPending) g.__mydeskPending = [];
const store = g.__mydeskPending;

// 书签脚本跨域需要 CORS 头
// 书签脚本跨域需要 CORS 头；公网页面访问 localhost 还需要私有网络放行头
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Private-Network": "true",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    store.unshift({ id: Date.now(), ...body });
    if (store.length > 32) store.pop();
    return NextResponse.json({ ok: true, received: true }, { headers: CORS });
  } catch {
    return NextResponse.json({ ok: false }, { status: 400, headers: CORS });
  }
}

export async function GET() {
  return NextResponse.json({ items: store }, { headers: CORS });
}

export async function DELETE() {
  store.length = 0;
  return NextResponse.json({ ok: true });
}
