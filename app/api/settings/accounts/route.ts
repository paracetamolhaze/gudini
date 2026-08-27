import { NextRequest, NextResponse } from "next/server";
import { activateAccount, listAccounts, removeAccount, Platform } from "@/lib/store";

const PLATFORMS: Platform[] = ["youtube", "tiktok", "instagram"];

function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && PLATFORMS.includes(value as Platform);
}

/** Переключение активного аккаунта платформы и удаление сохранённых. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { platform, id, action } = body ?? {};

  if (!isPlatform(platform) || typeof id !== "string" || !id) {
    return NextResponse.json({ error: "Нужны platform и id" }, { status: 400 });
  }

  if (action === "remove") {
    removeAccount(platform, id);
  } else if (action === "activate") {
    if (!activateAccount(platform, id)) {
      return NextResponse.json({ error: "Аккаунт не найден" }, { status: 404 });
    }
  } else {
    return NextResponse.json({ error: "action: activate | remove" }, { status: 400 });
  }

  return NextResponse.json({ accounts: listAccounts(platform) });
}
