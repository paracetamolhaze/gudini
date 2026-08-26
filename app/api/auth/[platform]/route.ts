import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/store";
import { requestOrigin } from "@/lib/origin";

type Ctx = { params: Promise<{ platform: string }> };

/** Начало OAuth-подключения аккаунта платформы. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { platform } = await params;
  const s = getSettings();
  const origin = requestOrigin(req);
  const redirect = `${origin}/api/auth/${platform}/callback`;

  if (platform === "youtube") {
    if (!s.googleClientId) return missing("Google Client ID/Secret (Google Cloud Console → YouTube Data API v3)");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", s.googleClientId);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "https://www.googleapis.com/auth/youtube.upload");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return NextResponse.redirect(url);
  }

  if (platform === "tiktok") {
    if (!s.tiktokClientKey) return missing("TikTok Client Key/Secret (developers.tiktok.com → Content Posting API)");
    // TikTok требует PKCE: challenge = hex(sha256(verifier)), verifier запоминаем в cookie
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("hex");
    const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
    url.searchParams.set("client_key", s.tiktokClientKey);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "user.info.basic,video.publish,video.upload");
    url.searchParams.set("state", "gudini");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const res = NextResponse.redirect(url);
    res.cookies.set("ttk_verifier", verifier, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
    return res;
  }

  if (platform === "instagram") {
    if (!s.metaAppId) return missing("Meta App ID/Secret (developers.facebook.com → Instagram Graph API)");
    const url = new URL("https://www.facebook.com/v21.0/dialog/oauth");
    url.searchParams.set("client_id", s.metaAppId);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("response_type", "code");
    if (s.metaConfigId) {
      // «Вход через Facebook для бизнеса» принимает только ID конфигурации, не список scope
      url.searchParams.set("config_id", s.metaConfigId);
    } else {
      url.searchParams.set(
        "scope",
        "instagram_basic,instagram_content_publish,pages_show_list,business_management",
      );
    }
    return NextResponse.redirect(url);
  }

  return NextResponse.json({ error: "Неизвестная платформа" }, { status: 400 });
}

function missing(what: string) {
  return NextResponse.json(
    { error: `Сначала укажите в Настройках: ${what}` },
    { status: 400 },
  );
}
