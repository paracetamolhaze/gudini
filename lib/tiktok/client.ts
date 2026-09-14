export async function tikTokBrowserRequest(action: string, body?: unknown): Promise<any> {
  const base = process.env.TIKTOK_BROWSER_URL || "http://127.0.0.1:43128";
  const response = await fetch(`${base}/${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.TIKTOK_BROWSER_TOKEN ?? ""}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000), cache: "no-store",
  }).catch(() => { throw new Error("Фоновый обработчик TikTok недоступен. Проверьте, что он запущен."); });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Ошибка фонового TikTok");
  return result;
}
