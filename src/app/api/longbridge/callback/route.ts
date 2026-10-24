import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { exchangeLongbridgeAuthCode, saveLongbridgeTokens } from "@/lib/desk/longbridge-mcp";

export const dynamic = "force-dynamic";

/**
 * GET /api/longbridge/callback?code=...&state=...
 * 长桥 OAuth 回调（当回调地址可达时使用，如未来有可达的公网回调）。
 * 从 /tmp/lb-pkce-httpbin.json 读 verifier（与 DCR 注册时生成的配对），
 * 用 code 换 token 后写入 .env。返回只含成功标志 + 脱敏 token，不返回完整 token。
 * VM 浏览器无法直达本回调时，改用 POST /api/longbridge/exchange（父代理从浏览器 URL 读 code 后调）。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = (url.searchParams.get("code") ?? "").trim();
  const state = (url.searchParams.get("state") ?? "").trim();
  const error = url.searchParams.get("error");
  if (error) return NextResponse.json({ ok: false, error: `长桥 OAuth 拒绝: ${error}` }, { status: 400 });
  if (!code) return NextResponse.json({ ok: false, error: "缺少 code" }, { status: 400 });
  try {
    // 读 verifier（与 authorize URL 配对生成，存于 /tmp，不进仓库）
    let verifier = "";
    let clientId = "";
    let redirectUri = "";
    try {
      let raw = "";
      try { raw = await fs.readFile("/tmp/lb-pkce-httpbin.json", "utf8"); }
      catch { raw = await fs.readFile(path.join(process.cwd(), ".lb-pkce-httpbin.json"), "utf8"); }
      const j = JSON.parse(raw) as Record<string, unknown>;
      if (typeof j["state"] === "string" && j["state"] === state) {
        verifier = typeof j["verifier"] === "string" ? (j["verifier"] as string) : "";
        clientId = typeof j["client_id"] === "string" ? (j["client_id"] as string) : "";
        redirectUri = typeof j["redirect_uri"] === "string" ? (j["redirect_uri"] as string) : "";
      }
    } catch {
      // 忽略，verifier 缺失时报错
    }
    if (!verifier || !clientId || !redirectUri) {
      return NextResponse.json({ ok: false, error: "verifier 未找到（需先生成 PKCE 并保存到 /tmp/lb-pkce-httpbin.json，或改用 POST /api/longbridge/exchange）" }, { status: 400 });
    }
    const { accessToken, refreshToken, expiresIn, refreshExpiresIn } = await exchangeLongbridgeAuthCode({ code, verifier, clientId, redirectUri });
    await saveLongbridgeTokens({ accessToken, refreshToken, clientId, expiresIn, refreshExpiresIn });
    const masked = accessToken.length > 8 ? `${accessToken.slice(0, 4)}…${accessToken.slice(-4)}` : "****";
    return NextResponse.json({ ok: true, maskedToken: masked, expiresIn, note: "已写入 .env，需重启 dev 生效" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "换 token 失败";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
