import { NextRequest, NextResponse } from "next/server";

/**
 * Callback деавторизации для Meta (Instagram/Facebook): платформа шлёт сюда POST,
 * когда пользователь отзывает доступ приложению. Gudini хранит только токены
 * владельца сайта, чужих данных нет — достаточно подтвердить получение.
 * Адрес вписывается в «Business login settings → Deauthorize callback URL».
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  return NextResponse.json({ ok: true, platform });
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
