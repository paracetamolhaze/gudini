import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requestOrigin } from "@/lib/origin";

/**
 * Callback запроса на удаление данных для Meta (Instagram/Facebook). Платформа
 * ждёт в ответе JSON с адресом страницы статуса и кодом подтверждения. Gudini не
 * хранит данных других пользователей — только токены владельца сайта, — поэтому
 * запрос подтверждается сразу. Адрес вписывается в «Business login settings →
 * Data deletion request URL».
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const code = crypto.randomBytes(8).toString("hex");
  const origin = requestOrigin(req);
  return NextResponse.json({
    url: `${origin}/privacy?deletion=${code}&platform=${encodeURIComponent(platform)}`,
    confirmation_code: code,
  });
}

export async function GET(req: NextRequest) {
  const origin = requestOrigin(req);
  return NextResponse.json({ ok: true, status: `${origin}/privacy` });
}
