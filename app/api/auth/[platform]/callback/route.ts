import { NextRequest, NextResponse } from "next/server";
import { connectAccount, getSettings } from "@/lib/store";
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
      const tokens = {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
      };
      const channel = await youtubeChannel(json.access_token);
      connectAccount("youtube", channel.id, channel.title, tokens);
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
      const tokens = {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
        open_id: json.open_id,
      };
      const name = await tiktokName(json.access_token);
      connectAccount("tiktok", json.open_id ?? name, name, tokens);
    } else if (platform === "instagram" && s.igAppId && s.igAppSecret) {
      // Прямой вход через Instagram: обмен кода → короткий токен → длинный токен (60 дней)
      const cleanCode = code.replace(/#_$/, "");
      const tokenRes = await fetch("https://api.instagram.com/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: s.igAppId,
          client_secret: s.igAppSecret,
          grant_type: "authorization_code",
          redirect_uri: redirect,
          code: cleanCode,
        }),
      });
      const token: any = await tokenRes.json();
      if (!token.access_token) throw new Error(JSON.stringify(token).slice(0, 300));

      let accessToken: string = token.access_token;
      try {
        const longLived: any = await (
          await fetch(
            `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${s.igAppSecret}&access_token=${accessToken}`,
          )
        ).json();
        if (longLived.access_token) accessToken = longLived.access_token;
      } catch {}

      // Публикация работает только с ID профессионального аккаунта (17841...),
      // а обмен кода отдаёт app-scoped ID (2805...) — на нём Graph отвечает
      // «Object with ID does not exist» (code 100, subcode 33).
      const profile = await instagramProfile(accessToken);
      const igId = profile.userId ?? String(token.user_id);
      connectAccount("instagram", igId, profile.name, {
        access_token: accessToken,
        ig_user_id: igId,
        via: "ig",
        expires_at: Date.now() + 60 * 24 * 3600 * 1000, // длинный токен Instagram живёт 60 дней
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

      const name = await instagramName(token.access_token, "https://graph.facebook.com/v21.0", igUserId);
      connectAccount("instagram", igUserId ?? "fb", name, {
        access_token: token.access_token,
        ig_user_id: igUserId,
        via: "fb",
      });
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


// ===== Имена аккаунтов для списка в настройках =====
// Любая ошибка здесь не должна ломать подключение — падаем на нейтральную подпись.

function fallbackLabel(prefix: string): string {
  return `${prefix} · ${new Date().toLocaleDateString("ru-RU")}`;
}

async function youtubeChannel(token: string): Promise<{ id: string; title: string }> {
  try {
    const res = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const json: any = await res.json();
    const item = json?.items?.[0];
    if (item?.id) return { id: item.id, title: item.snippet?.title ?? item.id };
  } catch {}
  // scope youtube.upload может не давать читать канал — это нормально
  return { id: `yt-${Date.now()}`, title: fallbackLabel("Канал YouTube") };
}

async function tiktokName(token: string): Promise<string> {
  try {
    const res = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=display_name", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json: any = await res.json();
    const name = json?.data?.user?.display_name;
    if (name) return name;
  } catch {}
  return fallbackLabel("TikTok");
}

async function instagramName(token: string, graph: string, igUserId?: string): Promise<string> {
  try {
    const target = igUserId ?? "me";
    const res = await fetch(`${graph}/${target}?fields=username&access_token=${token}`);
    const json: any = await res.json();
    if (json?.username) return `@${json.username}`;
  } catch {}
  return fallbackLabel("Instagram");
}

/**
 * Прямой вход через Instagram: /me отдаёт и app-scoped id, и user_id.
 * Для контент-публикации нужен именно user_id — ID профессионального аккаунта.
 */
async function instagramProfile(token: string): Promise<{ userId?: string; name: string }> {
  try {
    const res = await fetch(
      `https://graph.instagram.com/v21.0/me?fields=user_id,username&access_token=${token}`,
    );
    const json: any = await res.json();
    return {
      userId: json?.user_id ? String(json.user_id) : undefined,
      name: json?.username ? `@${json.username}` : fallbackLabel("Instagram"),
    };
  } catch {
    return { name: fallbackLabel("Instagram") };
  }
}
