import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/store";

type Ctx = { params: Promise<{ platform: string }> };

/** Начало OAuth-подключения аккаунта платформы. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { platform } = await params;
  const s = getSettings();
  const origin = req.nextUrl.origin;
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
    const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
    url.searchParams.set("client_key", s.tiktokClientKey);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "user.info.basic,video.publish");
    url.searchParams.set("state", "gudini");
    return NextResponse.redirect(url);
  }

  if (platform === "instagram") {
    if (!s.metaAppId) return missing("Meta App ID/Secret (developers.facebook.com → Instagram Graph API)");
    const url = new URL("https://www.facebook.com/v21.0/dialog/oauth");
    url.searchParams.set("client_id", s.metaAppId);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("response_type", "code");
    url.searchParams.set(
      "scope",
      "instagram_basic,instagram_content_publish,pages_show_list,business_management",
    );
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
