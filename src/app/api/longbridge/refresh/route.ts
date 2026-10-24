import { NextResponse } from "next/server";
import {
  getLongbridgeAuthStatus,
  LongbridgeRefreshExpiredError,
  refreshLongbridgeAccessToken,
} from "@/lib/desk/longbridge-mcp";

export const dynamic = "force-dynamic";

/**
 * GET /api/longbridge/refresh — 查询长桥 Token 状态（不返回 Token 本身）。
 * 返回 { configured, needsReauth, reason, tokenExpiresAt, refreshTokenExpiresAt }。
 *
 * POST /api/longbridge/refresh — 立即用 refresh_token 换新 access_token。
 * body 可选 { clientId }（首次补齐 LONGBRIDGE_MCP_CLIENT_ID 时传；之后从 .env 读）。
 * 成功 { ok, maskedToken, expiresIn, refreshExpiresIn, tokenExpiresAt, refreshExpiresAt }。
 * refresh_token 失效时 401 { ok:false, error:"refresh_token 已过期，需重新授权" }，
 * 需用户重新走一次浏览器授权；其余失败 500。
 * 换新后自动写回 .env + 更新本进程内存，无需重启 dev。
 */
export async function GET() {
  const s = getLongbridgeAuthStatus();
  const refreshExpiresAt = Number(process.env.LONGBRIDGE_MCP_REFRESH_TOKEN_EXPIRES_AT ?? "");
  return NextResponse.json({
    configured: s.configured,
    needsReauth: s.needsReauth,
    reason: s.reason,
    tokenExpiresAt: s.tokenExpiresAt,
    refreshTokenExpiresAt: Number.isFinite(refreshExpiresAt) && refreshExpiresAt > 0 ? refreshExpiresAt : null,
    hasRefreshToken: Boolean((process.env.LONGBRIDGE_MCP_REFRESH_TOKEN ?? "").trim()),
    hasClientId: Boolean((process.env.LONGBRIDGE_MCP_CLIENT_ID ?? "").trim()),
  });
}

export async function POST(req: Request) {
  try {
    let clientId: string | undefined;
    try {
      const body = (await req.json()) as Record<string, unknown>;
      if (typeof body["clientId"] === "string" && (body["clientId"] as string).trim()) {
        clientId = (body["clientId"] as string).trim();
      }
    } catch {
      // 无 body 也可刷新（clientId 从 env 读）
    }
    const r = await refreshLongbridgeAccessToken(clientId ? { clientId } : undefined);
    const masked = r.accessToken.length > 8 ? `${r.accessToken.slice(0, 4)}…${r.accessToken.slice(-4)}` : "****";
    return NextResponse.json({
      ok: true,
      maskedToken: masked,
      expiresIn: r.expiresIn,
      refreshExpiresIn: r.refreshExpiresIn,
      tokenExpiresAt: r.tokenExpiresAt,
      refreshExpiresAt: r.refreshExpiresAt,
      note: "已写回 .env，本进程内存已更新，无需重启 dev",
    });
  } catch (e) {
    if (e instanceof LongbridgeRefreshExpiredError) {
      return NextResponse.json({ ok: false, error: "refresh_token 已过期，需重新授权" }, { status: 401 });
    }
    const msg = e instanceof Error ? e.message : "刷新失败";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
