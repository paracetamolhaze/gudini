import { NextRequest, NextResponse } from "next/server";
import { getSettings, hasFace, hasMusic, saveSettings } from "@/lib/store";

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
    // пустые и замаскированные значения не перезаписывают сохранённые
    if (typeof value === "string" && value.trim() && !value.includes("••••")) {
      patch[field] = value.trim();
    }
  }
  saveSettings(patch);
  return NextResponse.json({ ok: true });
}
