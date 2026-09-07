import { NextRequest, NextResponse } from "next/server";
import { coverFontFile, getSettings, hasFace, hasMusic, listAccounts, saveSettings } from "@/lib/store";

function mask(value?: string): string {
  if (!value) return "";
  return value.length <= 8 ? "••••" : value.slice(0, 4) + "••••" + value.slice(-4);
}

export async function GET() {
  const s = getSettings();
  return NextResponse.json({
    anthropicKey: mask(s.anthropicKey),
    openaiKey: mask(s.openaiKey),
    elevenLabsKey: mask(s.elevenLabsKey),
    pexelsKey: mask(s.pexelsKey),
    pixabayKey: mask(s.pixabayKey),
    runwayKey: mask(s.runwayKey),
    music: hasMusic(),
    face: hasFace(),
    coverFont: Boolean(coverFontFile()),
    googleClientId: s.googleClientId ?? "",
    googleClientSecret: mask(s.googleClientSecret),
    tiktokClientKey: s.tiktokClientKey ?? "",
    tiktokClientSecret: mask(s.tiktokClientSecret),
    metaAppId: s.metaAppId ?? "",
    metaAppSecret: mask(s.metaAppSecret),
    metaConfigId: s.metaConfigId ?? "",
    igAppId: s.igAppId ?? "",
    igAppSecret: mask(s.igAppSecret),
    publicBaseUrl: s.publicBaseUrl ?? "",
    connected: {
      youtube: Boolean(s.youtubeTokens),
      tiktok: Boolean(s.tiktokTokens),
      instagram: Boolean(s.instagramTokens),
    },
    accounts: {
      youtube: listAccounts("youtube"),
      tiktok: listAccounts("tiktok"),
      instagram: listAccounts("instagram"),
    },
  });
}

const FIELDS = [
  "anthropicKey",
  "openaiKey",
  "elevenLabsKey",
  "pexelsKey",
  "pixabayKey",
  "runwayKey",
  "googleClientId",
  "googleClientSecret",
  "tiktokClientKey",
  "tiktokClientSecret",
  "metaAppId",
  "metaAppSecret",
  "metaConfigId",
  "igAppId",
  "igAppSecret",
  "publicBaseUrl",
] as const;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const patch: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = body[field];
    if (typeof value !== "string") continue;
    // замаскированное значение = поле не трогали, сохранённое остаётся
    if (value.includes("••••")) continue;
    // пустая строка = явная очистка (в т.ч. отключение fallback на переменную окружения)
    patch[field] = value.trim();
  }
  saveSettings(patch);
  return NextResponse.json({ ok: true });
}
