import { NextRequest } from "next/server";
import { guard, ok } from "@/lib/carousel/http";
import { budgetStatus, readSpend } from "@/lib/carousel/spend";

export const dynamic = "force-dynamic";

/** Бюджет раздела и последние записи его журнала (без секретов). */
export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  const entries = readSpend();
  const carouselId = req.nextUrl.searchParams.get("carousel");
  return ok({
    budget: budgetStatus(Date.now(), entries),
    entries: entries
      .filter((e) => !carouselId || e.carouselId === carouselId)
      .slice(-200)
      .reverse(),
  });
}
