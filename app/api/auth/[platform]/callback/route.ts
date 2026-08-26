import { NextRequest, NextResponse } from "next/server";
import { getSettings, saveSettings } from "@/lib/store";
import { requestOrigin } from "@/lib/origin";

type Ctx = { params: Promise<{ platform: string }> };

/** OAuth-callback: обмен кода на токены и сохранение подключения. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { platform } = await params;
  const code = req.nextUrl.searchParams.get("code");
  const origin = requestOrigin(req);
  const redirect = `${origin}/api/auth/${platform}/callback`;
  const s = getSettings();

  if (!code) return NextResponse.redirect(`${origin}/settings?error=no_code`);

  try {
    if (platform === "youtube") {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: s.googleClientId!,
          client_secret: s.googleClientSecret!,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirect,
        }),
      });
      const json: any = await res.json();
      if (!json.access_token) throw new Error(JSON.stringify(json).slice(0, 300));
      saveSettings({
        youtubeTokens: {
          access_token: json.access_token,
          refresh_token: json.refresh_token,
          expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
        },
      });
    } else if (platform === "tiktok") {
      const verifier = req.cookies.get("ttk_verifier")?.value;
      const body = new URLSearchParams({
        client_key: s.tiktokClientKey!,
        client_secret: s.tiktokClientSecret!,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirect,
      });
      if (verifier) body.set("code_verifier", verifier);
      const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const json: any = await res.json();
      if (!json.access_token) throw new Error(JSON.stringify(json).slice(0, 300));
      saveSettings({
        tiktokTokens: {
          access_token: json.access_token,
          refresh_token: json.refresh_token,
          expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
          open_id: json.open_id,
        },
      });
    } else if (platform === "instagram") {
      const tokenRes = await fetch(
        `https://graph.facebook.com/v21.0/oauth/access_token?` +
          new URLSearchParams({
            client_id: s.metaAppId!,
            client_secret: s.metaAppSecret!,
            code,
            redirect_uri: redirect,
          }),
      );
      const token: any = await tokenRes.json();
      if (!token.access_token) throw new Error(JSON.stringify(token).slice(0, 300));

      // находим Instagram Business аккаунт, привязанный к странице
      let igUserId: string | undefined;
      try {
        const pages: any = await (
          await fetch(
            `https://graph.facebook.com/v21.0/me/accounts?fields=instagram_business_account&access_token=${token.access_token}`,
          )
        ).json();
        igUserId = pages?.data?.find((p: any) => p.instagram_business_account)?.instagram_business_account?.id;
      } catch {}

      saveSettings({ instagramTokens: { access_token: token.access_token, ig_user_id: igUserId } });
    } else {
      return NextResponse.redirect(`${origin}/settings?error=unknown_platform`);
    }
    return NextResponse.redirect(`${origin}/settings?connected=${platform}`);
  } catch (e: any) {
    return NextResponse.redirect(
      `${origin}/settings?error=${encodeURIComponent(String(e?.message ?? e).slice(0, 200))}`,
    );
  }
}
