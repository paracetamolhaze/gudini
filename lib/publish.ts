import fs from "fs";
import path from "path";
import { getProject, getSettings, projectDir, updateActiveTokens, Platform, Publication, updateProject } from "./store";

export type PublishResult = Omit<Publication, "at">;

/** Публикация на платформу. Без подключённого аккаунта — демо-режим (симуляция). */
export async function publish(id: string, platform: Platform): Promise<Publication> {
  const project = getProject(id);
  if (!project?.processedVideo) throw new Error("Сначала смонтируйте видео");
  const videoPath = path.join(projectDir(id), project.processedVideo);
  const title = project.meta?.title ?? project.topic;
  const description = [project.meta?.description ?? "", (project.meta?.hashtags ?? []).join(" ")]
    .filter(Boolean)
    .join("\n\n");

  const coverPath = project.cover ? path.join(projectDir(id), project.cover) : null;
  const coverMs = Math.round((project.coverOffsetSec ?? 1) * 1000);

  let result: PublishResult;
  try {
    if (platform === "youtube")
      result = await publishYouTube(videoPath, title, description, project.meta?.hashtags ?? [], coverPath);
    else if (platform === "tiktok") result = await publishTikTok(videoPath);
    else result = await publishInstagram(id, title, description, coverMs, Boolean(coverPath && fs.existsSync(coverPath)));
  } catch (e: any) {
    result = { platform, status: "error", message: String(e?.message ?? e) };
  }

  const publication: Publication = { ...result, at: new Date().toISOString() };
  const fresh = getProject(id)!;
  updateProject(id, { publications: [...fresh.publications.filter((p) => p.platform !== platform), publication] });
  return publication;
}

async function demo(platform: Platform, note: string): Promise<PublishResult> {
  await new Promise((r) => setTimeout(r, 1500));
  return {
    platform,
    status: "demo",
    message: `Демо-режим: ${note}. Видео готово к публикации — скачайте его или подключите аккаунт в Настройках.`,
  };
}

// ===== YouTube Shorts (YouTube Data API v3) =====

async function youtubeAccessToken(): Promise<string | null> {
  const s = getSettings();
  if (!s.youtubeTokens) return null;
  const { access_token, refresh_token, expires_at } = s.youtubeTokens;
  if (expires_at && Date.now() < expires_at - 60_000) return access_token;
  if (!refresh_token || !s.googleClientId || !s.googleClientSecret) return access_token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: s.googleClientId,
      client_secret: s.googleClientSecret,
      refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Не удалось обновить токен YouTube: ${await res.text()}`);
  const json: any = await res.json();
  updateActiveTokens("youtube", {
    access_token: json.access_token,
    refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
  });
  return json.access_token;
}

async function publishYouTube(
  videoPath: string,
  title: string,
  description: string,
  tags: string[],
  coverPath: string | null,
): Promise<PublishResult> {
  const token = await youtubeAccessToken();
  if (!token) return demo("youtube", "аккаунт YouTube не подключён");

  const metadata = {
    snippet: {
      title: title.slice(0, 100),
      description: description.slice(0, 4900),
      tags: tags.map((t) => t.replace(/^#/, "")).slice(0, 30),
      categoryId: "22",
    },
    // приватно = черновик: ролик виден только владельцу канала, публикует он сам из YouTube Studio
    status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
  };

  const boundary = "gudini" + Date.now();
  const video = fs.readFileSync(videoPath);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);

  const res = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: new Uint8Array(Buffer.concat([head, video, tail])),
    },
  );
  if (!res.ok) throw new Error(`YouTube API: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json: any = await res.json();

  const coverNote =
    coverPath && fs.existsSync(coverPath)
      ? await setYoutubeThumbnail(token, json.id, coverPath)
      : "Обложки нет — YouTube подставит кадр из видео.";
  return {
    platform: "youtube",
    status: "published",
    url: `https://youtube.com/shorts/${json.id}`,
    message: `Залито приватным черновиком — откройте YouTube Studio, проверьте и опубликуйте. ${coverNote}`,
  };
}

/** Установка обложки. Возвращает человеческую формулировку результата — молча не падаем. */
async function setYoutubeThumbnail(token: string, videoId: string, coverPath: string): Promise<string> {
  try {
    const res = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/jpeg" },
      body: new Uint8Array(fs.readFileSync(coverPath)),
    });
    if (res.ok) return "Обложка установлена.";
    const text = await res.text();
    // самая частая причина: канал без подтверждения по телефону не имеет права на свои обложки
    if (res.status === 403) {
      return (
        "ОБЛОЖКА НЕ ПРИМЕНЕНА: канал не верифицирован по телефону (youtube.com/verify). " +
        "Видео залито, обложку можно поставить вручную в Studio."
      );
    }
    return `ОБЛОЖКА НЕ ПРИМЕНЕНА (${res.status}): ${text.slice(0, 160)}`;
  } catch (e: any) {
    return `ОБЛОЖКА НЕ ПРИМЕНЕНА: ${String(e?.message ?? e).slice(0, 160)}`;
  }
}

// ===== TikTok (Content Posting API) =====

/**
 * Access-токен TikTok живёт ~24 часа, refresh — год. Без обновления публикация
 * отваливается на следующий день после подключения.
 */
async function tiktokAccessToken(): Promise<string | null> {
  const s = getSettings();
  if (!s.tiktokTokens) return null;
  const { access_token, refresh_token, expires_at, open_id } = s.tiktokTokens;
  if (expires_at && Date.now() < expires_at - 60_000) return access_token;
  if (!refresh_token || !s.tiktokClientKey || !s.tiktokClientSecret) return access_token;

  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: s.tiktokClientKey,
      client_secret: s.tiktokClientSecret,
      grant_type: "refresh_token",
      refresh_token,
    }),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    throw new Error(
      "Токен TikTok истёк и не обновился — переподключите TikTok в Настройках: " +
        String(json?.error_description ?? json?.error ?? res.status).slice(0, 160),
    );
  }

  const tokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 86_400) * 1000,
    open_id: json.open_id ?? open_id,
  };
  updateActiveTokens("tiktok", tokens);
  return tokens.access_token;
}

async function publishTikTok(videoPath: string): Promise<PublishResult> {
  const token = await tiktokAccessToken();
  if (!token) return demo("tiktok", "аккаунт TikTok не подключён");

  const video = fs.readFileSync(videoPath);
  // inbox = черновик: ролик приезжает в «Уведомления → Загрузки», подпись и обложку
  // автор выбирает сам в приложении. В отличие от Direct Post не требует аудита
  // Content Posting API и не упирается в принудительный SELF_ONLY.
  const initRes = await fetch("https://open.tiktokapis.com/v2/post/publish/inbox/video/init/", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      source_info: {
        source: "FILE_UPLOAD",
        video_size: video.length,
        chunk_size: video.length,
        total_chunk_count: 1,
      },
    }),
  });
  if (!initRes.ok) throw new Error(`TikTok init: ${initRes.status} ${(await initRes.text()).slice(0, 300)}`);

  const init: any = await initRes.json();
  const uploadUrl = init?.data?.upload_url;
  if (!uploadUrl) throw new Error(`TikTok: ${JSON.stringify(init).slice(0, 300)}`);

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Range": `bytes 0-${video.length - 1}/${video.length}`,
    },
    body: new Uint8Array(video),
  });
  if (!putRes.ok) throw new Error(`TikTok upload: ${putRes.status}`);

  return {
    platform: "tiktok",
    status: "published",
    message: "Залито в черновики TikTok — откройте приложение: Уведомления → Загрузки, там подпись и публикация.",
  };
}

// ===== Instagram Reels (Graph API) =====

/**
 * Длинный токен Instagram живёт 60 дней и продлевается ещё на 60 одним запросом.
 * Продлеваем заранее; неудача не должна ломать публикацию — текущий токен ещё жив.
 */
async function instagramAccessToken(tokens: { access_token: string; via?: "ig" | "fb"; expires_at?: number }): Promise<string> {
  const WEEK = 7 * 24 * 3600 * 1000;
  if (tokens.via === "fb") return tokens.access_token;
  if (tokens.expires_at && tokens.expires_at - Date.now() > WEEK) return tokens.access_token;

  try {
    const res = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${tokens.access_token}`,
    );
    const json: any = await res.json();
    if (json?.access_token) {
      const fresh = {
        ...tokens,
        access_token: json.access_token,
        expires_at: Date.now() + (json.expires_in ?? 60 * 24 * 3600) * 1000,
      };
      updateActiveTokens("instagram", fresh);
      return fresh.access_token;
    }
  } catch {}
  // токен младше суток продлить нельзя — это нормально, работаем текущим
  return tokens.access_token;
}


async function publishInstagram(
  id: string,
  title: string,
  description: string,
  coverMs: number,
  hasCover: boolean,
): Promise<PublishResult> {
  const s = getSettings();
  const igUser = s.instagramTokens?.ig_user_id;
  if (!s.instagramTokens?.access_token || !igUser) return demo("instagram", "аккаунт Instagram не подключён");
  const token = await instagramAccessToken(s.instagramTokens);
  if (!s.publicBaseUrl) {
    return demo(
      "instagram",
      "для Reels нужен публичный URL видео (Instagram скачивает файл по ссылке) — задайте PUBLIC_BASE_URL после деплоя",
    );
  }

  const base = s.publicBaseUrl.replace(/\/$/, "");
  const videoUrl = `${base}/api/projects/${id}/video?which=processed`;
  const caption = `${title}\n\n${description}`.slice(0, 2200);
  // прямой вход через Instagram → graph.instagram.com; вход через Facebook → graph.facebook.com
  const graph = s.instagramTokens?.via === "ig" ? "https://graph.instagram.com" : "https://graph.facebook.com";

  // своя обложка (cover_url) приоритетнее кадра по таймкоду: Instagram скачает её по ссылке
  const params: Record<string, string> = {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    access_token: token,
  };
  if (hasCover) params.cover_url = `${base}/api/projects/${id}/video?which=cover`;
  else params.thumb_offset = String(coverMs);

  const containerRes = await fetch(`${graph}/v21.0/${igUser}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!containerRes.ok) {
    const text = await containerRes.text();
    // code 100 / subcode 33: сохранён не тот ID аккаунта — лечится переподключением
    if (/error_subcode":\s*33|does not exist, cannot be loaded/.test(text)) {
      throw new Error(
        "Instagram не принял ID аккаунта. Переподключите Instagram в Настройках: " +
          "сохранён служебный ID вместо ID профессионального аккаунта.",
      );
    }
    throw new Error(`IG container: ${text.slice(0, 300)}`);
  }
  const container: any = await containerRes.json();

  // ждём обработки контейнера
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st: any = await (
      await fetch(`${graph}/v21.0/${container.id}?fields=status_code&access_token=${token}`)
    ).json();
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR") throw new Error("Instagram не смог обработать видео");
  }

  const pubRes = await fetch(`${graph}/v21.0/${igUser}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: container.id, access_token: token }),
  });
  if (!pubRes.ok) throw new Error(`IG publish: ${(await pubRes.text()).slice(0, 300)}`);
  const pub: any = await pubRes.json();
  return {
    platform: "instagram",
    status: "published",
    message: `Опубликовано (media id ${pub.id}). ${hasCover ? "Обложка своя." : "Обложки нет — взят кадр из видео."}`,
  };
}
