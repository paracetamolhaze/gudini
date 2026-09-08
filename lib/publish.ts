import fs from "fs";
import path from "path";
import { getProject, getSettings, projectDir, updateActiveTokens, Platform, Publication, updateProject } from "./store";
import { runFfmpeg } from "./ffmpeg";

export type PublishResult = Omit<Publication, "at">;

/** Что автор выбрал на экране публикации TikTok (Direct Post требует его выбора, а не наших значений по умолчанию). */
export type TikTokPostOptions = {
  title: string;
  privacyLevel: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  coverMs: number;
  brandContent: boolean;
  brandOrganic: boolean;
  consent: boolean;
};

/**
 * live — как настроено (YouTube по YOUTUBE_PRIVACY, TikTok по TIKTOK_DIRECT_POST, Instagram сразу);
 * draft — «сначала проверить»: YouTube приватным черновиком, TikTok в черновики приложения,
 * Instagram пропускается — черновиков у его API нет.
 */
export type PublishMode = "live" | "draft";

export type PublishOptions = { tiktok?: TikTokPostOptions; mode?: PublishMode; style?: "cards" | "ai_film" };

/**
 * Обложка первым кадром. YouTube для Shorts и TikTok не показывают свою картинку, даже
 * если API её принял: превью берётся из кадра видео. Поэтому для них публикуется копия
 * ролика, где обложка стоит первым кадром на COVER_LEAD_SEC секунд (по умолчанию 0.2),
 * и превью получается своей. Исходный монтаж не меняется; Instagram получает оригинал
 * и обложку по ссылке. 0 выключает.
 */
export const coverLeadSec = (): number => {
  // один кадр при 30 fps: превью TikTok — кадр 0, зрителю вспышка не видна
  const v = Number(process.env.COVER_LEAD_SEC ?? "0.034");
  return Number.isFinite(v) && v > 0 ? Math.min(v, 2) : 0;
};

async function withCoverLead(dir: string, videoFile: string, coverFile: string | null): Promise<string> {
  const lead = coverLeadSec();
  if (!lead || !coverFile || !fs.existsSync(path.join(dir, coverFile))) return videoFile;
  const src = path.join(dir, videoFile);
  const out = "out-lead.mp4";
  const stamp = [fs.statSync(src).size, fs.statSync(src).mtimeMs, fs.statSync(path.join(dir, coverFile)).mtimeMs, lead].join(":");
  const stampFile = path.join(dir, out + ".stamp");
  if (fs.existsSync(path.join(dir, out)) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === stamp) return out;
  await runFfmpeg(
    [
      "-loop", "1", "-framerate", "30", "-t", String(lead), "-i", coverFile,
      "-i", videoFile,
      "-f", "lavfi", "-t", String(lead), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-filter_complex",
      "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p[c];" +
        "[2:a]aformat=sample_rates=48000:channel_layouts=stereo[a0];" +
        "[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a1];" +
        "[c][a0][1:v][a1]concat=n=2:v=1:a=1[v][a]",
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", "30", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
      out,
    ],
    { cwd: dir },
  );
  fs.writeFileSync(stampFile, stamp, "utf8");
  return out;
}

/** Публикация на платформу. Без подключённого аккаунта — демо-режим (симуляция). */
export async function publish(id: string, platform: Platform, options: PublishOptions = {}): Promise<Publication> {
  const project = getProject(id);
  // выбранный стиль публикуется из своей копии; без выбора — последний смонтированный ролик
  const source = options.style && project?.outputs?.[options.style]?.file ? project.outputs[options.style]!.file : project?.processedVideo;
  if (!project || !source) throw new Error("Сначала смонтируйте видео");
  const dir = projectDir(id);
  // TikTok — копия с обложкой первым кадром (кадр 0 и есть превью); YouTube и Instagram — оригинал:
  // у Shorts свою обложку не показать никак, у Instagram она уходит по ссылке
  const videoFile = platform === "tiktok" ? await withCoverLead(dir, source, project.cover ?? null) : source;
  const videoPath = path.join(dir, videoFile);
  const leadUsed = videoFile !== source;
  const title = project.meta?.title ?? project.topic;
  const description = [project.meta?.description ?? "", (project.meta?.hashtags ?? []).join(" ")]
    .filter(Boolean)
    .join("\n\n");

  const coverPath = project.cover ? path.join(projectDir(id), project.cover) : null;
  // с обложкой первым кадром кадр превью — нулевой
  const coverMs = leadUsed ? 0 : Math.round((project.coverOffsetSec ?? 1) * 1000);

  const mode: PublishMode = options.mode === "draft" ? "draft" : "live";
  let result: PublishResult;
  try {
    if (platform === "youtube")
      result = await publishYouTube(videoPath, title, description, project.meta?.hashtags ?? [], coverPath, mode);
    else if (platform === "tiktok") result = await publishTikTok(videoPath, title, description, coverMs, options.tiktok, mode);
    else if (mode === "draft")
      result = {
        platform,
        status: "skipped",
        message: "Черновиков в Instagram через API нет — в режиме проверки пропущен, публикуйте кнопкой «во все» или отдельной.",
      };
    else result = await publishInstagram(id, title, description, coverMs, Boolean(coverPath && fs.existsSync(coverPath)), options.style);
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
  mode: PublishMode = "live",
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
    // YOUTUBE_PRIVACY=public — ролик выходит сразу; по умолчанию private: черновик, который
    // владелец канала проверяет и публикует из YouTube Studio
    status: { privacyStatus: mode === "draft" ? "private" : youtubePrivacy(), selfDeclaredMadeForKids: false },
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
  const privacy = mode === "draft" ? "private" : youtubePrivacy();
  // сообщение только о том, что не очевидно: черновик, доступ по ссылке, не принятая обложка
  void coverNote; // у Shorts своя обложка не показывается — результат установки в карточку не пишем
  const notes = [privacy === "private" ? "Черновик в YouTube Studio." : privacy === "unlisted" ? "Доступ по ссылке." : null].filter(Boolean);
  return {
    platform: "youtube",
    status: "published",
    url: `https://youtube.com/shorts/${json.id}`,
    message: notes.length ? notes.join(" ") : undefined,
  };
}

/** Видимость ролика на YouTube из настройки; неизвестное значение — приватный черновик. */
function youtubePrivacy(): "private" | "unlisted" | "public" {
  const v = String(process.env.YOUTUBE_PRIVACY ?? "private").toLowerCase();
  return v === "public" || v === "unlisted" ? v : "private";
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

export const tiktokDirectPostEnabled = () => process.env.TIKTOK_DIRECT_POST === "1";

export type TikTokCreatorInfo = {
  nickname: string;
  avatarUrl: string;
  /** какие уровни видимости TikTok разрешает этому автору; без аудита приложения — только SELF_ONLY */
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxDurationSec: number;
};

/**
 * Автор и его ограничения из creator_info. TikTok требует спрашивать это перед каждой
 * прямой публикацией и показывать пользователю: экран публикации строится по этим данным.
 */
export async function tiktokCreatorInfo(): Promise<TikTokCreatorInfo | null> {
  const token = await tiktokAccessToken();
  if (!token) return null;
  const res = await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const info: any = await res.json().catch(() => ({}));
  if (!res.ok || info?.error?.code !== "ok") {
    throw new Error(`TikTok creator_info: ${res.status} ${String(info?.error?.message ?? "").slice(0, 200)}`);
  }
  const d = info?.data ?? {};
  return {
    nickname: String(d.creator_nickname ?? ""),
    avatarUrl: String(d.creator_avatar_url ?? ""),
    privacyOptions: Array.isArray(d.privacy_level_options) ? d.privacy_level_options.map(String) : [],
    commentDisabled: Boolean(d.comment_disabled),
    duetDisabled: Boolean(d.duet_disabled),
    stitchDisabled: Boolean(d.stitch_disabled),
    maxDurationSec: Number(d.max_video_post_duration_sec ?? 0),
  };
}

const TIKTOK_CHUNK = 32 * 1024 * 1024;
const TIKTOK_SINGLE_MAX = 64 * 1024 * 1024;

/** Разбиение файла по правилам TikTok: до 64 МБ — один кусок, иначе куски по 32 МБ, остаток — в последний. */
function tiktokChunkPlan(size: number): { chunkSize: number; count: number } {
  if (size <= TIKTOK_SINGLE_MAX) return { chunkSize: size, count: 1 };
  return { chunkSize: TIKTOK_CHUNK, count: Math.floor(size / TIKTOK_CHUNK) };
}

/** Последовательная отправка кусков на upload_url: промежуточные — 206, последний — 201. */
async function tiktokUploadChunks(uploadUrl: string, video: Buffer, plan: { chunkSize: number; count: number }): Promise<void> {
  for (let i = 0; i < plan.count; i++) {
    const start = i * plan.chunkSize;
    const end = i === plan.count - 1 ? video.length - 1 : start + plan.chunkSize - 1;
    const chunk = video.subarray(start, end + 1);
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${start}-${end}/${video.length}`,
      },
      body: new Uint8Array(chunk),
    });
    if (!res.ok) {
      throw new Error(`TikTok upload: кусок ${i + 1} из ${plan.count} (${start}-${end}) отклонён: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }
}

/**
 * Два режима. Черновик (по умолчанию): ролик приезжает в «Уведомления → Загрузки»,
 * подпись и обложку автор выбирает сам в приложении; аудита не требует.
 * TIKTOK_DIRECT_POST=1 — прямая публикация с тем, что автор выбрал на экране публикации:
 * подпись, видимость из списка creator_info, комментарии/дуэты/стичи, кадр обложки,
 * пометка коммерческого контента, согласие с правилами. Своих значений по умолчанию нет —
 * этого требуют правила TikTok для Direct Post. Пока приложение не прошло аудит, TikTok
 * разрешает только SELF_ONLY, и это видно в списке видимости.
 */
async function publishTikTok(
  videoPath: string,
  title: string,
  description: string,
  coverMs: number,
  opts?: TikTokPostOptions,
  mode: PublishMode = "live",
): Promise<PublishResult> {
  const token = await tiktokAccessToken();
  if (!token) return demo("tiktok", "аккаунт TikTok не подключён");

  const video = fs.readFileSync(videoPath);
  // режим проверки — всегда черновик в приложении, даже если включена прямая публикация
  const direct = tiktokDirectPostEnabled() && mode !== "draft";
  // Правила TikTok для FILE_UPLOAD: кусок от 5 до 64 МБ; файл до 64 МБ — одним куском,
  // больше — кусками по 32 МБ, остаток уходит в последний кусок. Ролик 113 МБ одним
  // куском давал invalid_params «The chunk size is invalid».
  const plan = tiktokChunkPlan(video.length);
  const source_info = {
    source: "FILE_UPLOAD",
    video_size: video.length,
    chunk_size: plan.chunkSize,
    total_chunk_count: plan.count,
  };

  let privacy = "";
  let privacyNote = "";
  let body: Record<string, unknown> = { source_info };
  if (direct) {
    if (!opts) {
      throw new Error("Прямая публикация в TikTok идёт только с экрана публикации: подпись, кто увидит видео, согласие с правилами");
    }
    if (!opts.consent) throw new Error("TikTok: перед публикацией нужно подтвердить согласие с правилами");
    const info = await tiktokCreatorInfo();
    if (!info) return demo("tiktok", "аккаунт TikTok не подключён");
    if (!info.privacyOptions.includes(opts.privacyLevel)) {
      throw new Error(`TikTok: видимость ${opts.privacyLevel || "не выбрана"} недоступна этому аккаунту (доступны: ${info.privacyOptions.join(", ") || "нет"})`);
    }
    if (opts.brandContent && opts.privacyLevel === "SELF_ONLY") {
      throw new Error("TikTok: брендированный контент нельзя публиковать с видимостью «только я»");
    }
    privacy = opts.privacyLevel;
    body = {
      post_info: {
        // подпись — то, что автор отредактировал на экране; лимит TikTok 2200 символов
        title: String(opts.title ?? `${title}\n\n${description}`).slice(0, 2200),
        privacy_level: privacy,
        disable_comment: !opts.allowComment || info.commentDisabled,
        disable_duet: !opts.allowDuet || info.duetDisabled,
        disable_stitch: !opts.allowStitch || info.stitchDisabled,
        // своей картинки API TikTok не принимает — только кадр из видео по таймкоду
        video_cover_timestamp_ms: Math.max(0, Math.round(Number(opts.coverMs) || coverMs)),
        brand_content_toggle: Boolean(opts.brandContent),
        brand_organic_toggle: Boolean(opts.brandOrganic),
      },
      source_info,
    };
    if (privacy === "SELF_ONLY" && info.privacyOptions.length === 1) {
      privacyNote = "Видимость «только я»: приложение ещё не прошло аудит TikTok.";
    }
  }

  const initUrl = direct
    ? "https://open.tiktokapis.com/v2/post/publish/video/init/"
    : "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
  const initRes = await fetch(initUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!initRes.ok) {
    const text = await initRes.text();
    // до аудита TikTok публикует только в приватный аккаунт — это настройка аккаунта, не сайта
    if (/unaudited_client_can_only_post_to_private_accounts/.test(text)) {
      throw new Error(
        "TikTok: пока приложение не прошло аудит, публиковать можно только в приватный аккаунт. " +
          "В приложении TikTok: Настройки и конфиденциальность → Конфиденциальность → «Приватный аккаунт», затем повторите.",
      );
    }
    throw new Error(`TikTok init: ${initRes.status} ${text.slice(0, 300)}`);
  }

  const init: any = await initRes.json();
  const uploadUrl = init?.data?.upload_url;
  if (!uploadUrl) throw new Error(`TikTok: ${JSON.stringify(init).slice(0, 300)}`);

  await tiktokUploadChunks(uploadUrl, video, plan);

  if (!direct) {
    return { platform: "tiktok", status: "published", message: "Черновик в TikTok: Уведомления → Загрузки." };
  }

  // прямая публикация обрабатывается на стороне TikTok: ждём итог, чтобы не назвать упавшее опубликованным
  const publishId = String(init?.data?.publish_id ?? "");
  let status = "PROCESSING_UPLOAD";
  let failReason = "";
  for (let i = 0; i < 24 && publishId; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const stRes = await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const st: any = await stRes.json().catch(() => ({}));
    status = String(st?.data?.status ?? status);
    failReason = String(st?.data?.fail_reason ?? "");
    if (status === "PUBLISH_COMPLETE" || status === "FAILED") break;
  }
  if (status === "FAILED") throw new Error(`TikTok не опубликовал ролик: ${failReason || "причина не названа"}`);
  const notes = [
    status === "PUBLISH_COMPLETE" ? null : `Обработка в TikTok ещё идёт (${status}) — проверьте профиль через минуту.`,
    privacyNote || null,
  ].filter(Boolean);
  return { platform: "tiktok", status: "published", message: notes.length ? notes.join(" ") : undefined };
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
  videoStyle?: "cards" | "ai_film",
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
  const videoUrl = `${base}/api/projects/${id}/video?which=processed${videoStyle ? `&style=${videoStyle}` : ""}`;
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
  // ссылка на сам Reels: Graph API отдаёт permalink по id опубликованного медиа
  let url: string | undefined;
  try {
    const link: any = await (await fetch(`${graph}/v21.0/${pub.id}?fields=permalink&access_token=${token}`)).json();
    if (typeof link?.permalink === "string") url = link.permalink;
  } catch {}
  return {
    platform: "instagram",
    status: "published",
    url,
    message: hasCover ? undefined : "Обложки нет — взят кадр из видео.",
  };
}
