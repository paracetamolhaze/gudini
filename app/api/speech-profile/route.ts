import { NextResponse } from "next/server";
import { readSpeechProfile } from "@/lib/speechProfile";

/** Профиль подачи автора (темп, фразы): телесуфлёр берёт из него скорость текста по умолчанию. */
export async function GET() {
  return NextResponse.json(readSpeechProfile() ?? {});
}
