import { NextResponse } from "next/server";
import { exchangeLongbridgeAuthCode, saveLongbridgeTokens } from "@/lib/desk/longbridge-mcp";

export const dynamic = "force-dynamic";

/**
 * POST /api/longbridge/exchange
 * 用授权码换长桥 MCP OAuth token，存入 .env。
 *  body: { code, verifier, clientId, redirectUri }
 *  用途：VM 浏览器无法直达 MyDesk 回调时，父代理从浏览器 URL / httpbin 页读出 code，
 *  再调本接口换 token，无需用户手动拷码，也无需浏览器能到 MyDesk。
 *  返回只含成功标志 + 脱敏 token（首 4 + 末 4），不返回完整 token，不写日志。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const code = typeof body["code"] === "string" ? (body["code"] as string).trim() : "";
    const verifier = typeof body["verifier"] === "string" ? (body["verifier"] as string).trim() : "";
    const clientId = typeof body["clientId"] === "string" ? (body["clientId"] as string).trim() : "";
    const redirectUri = typeof body["redirectUri"] === "string" ? (body["redirectUri"] as string).trim() : "";
    if (!code || !verifier || !clientId || !redirectUri) {
      return NextResponse.json({ ok: false, error: "缺少 code / verifier / clientId / redirectUri" }, { status: 400 });
    }
    const { accessToken, refreshToken, expiresIn, refreshExpiresIn } = await exchangeLongbridgeAuthCode({ code, verifier, clientId, redirectUri });
    // 写入内存 + .env（共用 saveLongbridgeTokens：Token + refresh_token + client_id + 过期时间；其余行原样保留）
    await saveLongbridgeTokens({ accessToken, refreshToken, clientId, expiresIn, refreshExpiresIn });
    const masked = accessToken.length > 8 ? `${accessToken.slice(0, 4)}…${accessToken.slice(-4)}` : "****";
    return NextResponse.json({ ok: true, maskedToken: masked, expiresIn, note: "已写入 .env，需重启 dev 生效" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "换 token 失败";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
