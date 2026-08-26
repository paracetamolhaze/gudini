import fs from "fs";
import path from "path";
import { getProject, getSettings, projectDir, saveSettings, Platform, Publication, updateProject } from "./store";

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
    else if (platform === "tiktok") result = await publishTikTok(videoPath, title, description, coverMs);
    else result = await publishInstagram(id, title, description, coverMs);
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
  saveSettings({
    youtubeTokens: { access_token: json.access_token, refresh_token, expires_at: Date.now() + json.expires_in * 1000 },
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
    status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
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

  // пробуем поставить сгенерированную обложку (работает на верифицированных каналах)
  if (coverPath && fs.existsSync(coverPath)) {
    try {
      await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${json.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/jpeg" },
        body: new Uint8Array(fs.readFileSync(coverPath)),
      });
    } catch {}
  }
  return { platform: "youtube", status: "published", url: `https://youtube.com/shorts/${json.id}` };
}

// ===== TikTok (Content Posting API) =====

async function publishTikTok(videoPath: string, title: string, description: string, coverMs: number): Promise<PublishResult> {
  const s = getSettings();
  const token = s.tiktokTokens?.access_token;
  if (!token) return demo("tiktok", "аккаунт TikTok не подключён");

  const video = fs.readFileSync(videoPath);
  const initBody = (privacy: string) =>
    JSON.stringify({
      post_info: {
        title: `${title}\n${description}`.slice(0, 2200),
        privacy_level: privacy,
        video_cover_timestamp_ms: coverMs,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: video.length,
        chunk_size: video.length,
        total_chunk_count: 1,
      },
    });
  const initCall = (privacy: string) =>
    fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: initBody(privacy),
    });

  let privacy = "PUBLIC_TO_EVERYONE";
  let initRes = await initCall(privacy);
  if (!initRes.ok) {
    const text = await initRes.text();
    // приложение без аудита TikTok может публиковать только приватно — пробуем SELF_ONLY
    if (/unaudited|privacy_level/i.test(text)) {
      privacy = "SELF_ONLY";
      initRes = await initCall(privacy);
      if (!initRes.ok) throw new Error(`TikTok init: ${initRes.status} ${(await initRes.text()).slice(0, 300)}`);
    } else {
      throw new Error(`TikTok init: ${initRes.status} ${text.slice(0, 300)}`);
    }
  }
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
    message:
      privacy === "SELF_ONLY"
        ? "Видео загружено как приватное: приложение ещё не прошло аудит TikTok (Content Posting API). После аудита публикация станет публичной."
        : "Видео отправлено в TikTok — проверьте вкладку «Черновики/Публикации» в приложении",
  };
}

// ===== Instagram Reels (Graph API) =====

async function publishInstagram(id: string, title: string, description: string, coverMs: number): Promise<PublishResult> {
  const s = getSettings();
  const token = s.instagramTokens?.access_token;
  const igUser = s.instagramTokens?.ig_user_id;
  if (!token || !igUser) return demo("instagram", "аккаунт Instagram не подключён");
  if (!s.publicBaseUrl) {
    return demo(
      "instagram",
      "для Reels нужен публичный URL видео (Instagram скачивает файл по ссылке) — задайте PUBLIC_BASE_URL после деплоя",
    );
  }

  const videoUrl = `${s.publicBaseUrl.replace(/\/$/, "")}/api/projects/${id}/video?which=processed`;
  const caption = `${title}\n\n${description}`.slice(0, 2200);
  // прямой вход через Instagram → graph.instagram.com; вход через Facebook → graph.facebook.com
  const graph = s.instagramTokens?.via === "ig" ? "https://graph.instagram.com" : "https://graph.facebook.com";

  const containerRes = await fetch(`${graph}/v21.0/${igUser}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      media_type: "REELS",
      video_url: videoUrl,
      caption,
      thumb_offset: String(coverMs),
      access_token: token,
    }),
  });
  if (!containerRes.ok) throw new Error(`IG container: ${(await containerRes.text()).slice(0, 300)}`);
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
  return { platform: "instagram", status: "published", message: `Опубликовано (media id ${pub.id})` };
}
