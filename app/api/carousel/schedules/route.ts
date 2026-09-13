import { NextRequest } from "next/server";
import { fail, guard, ok } from "@/lib/carousel/http";
import { listCarousels } from "@/lib/carousel/store";
import { scheduleSummary } from "@/lib/carousel/schedule";
import { runSchedulerTick } from "@/lib/carousel/runnerControl";

export const dynamic = "force-dynamic";

/** Запланированные публикации по всем каруселям: ожидающие, идущие, просроченные, недавние итоги. */
export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    // просмотр списка — повод проверить, не пришло ли время: планировщик не зависит от вкладки, но и не ждёт её
    runSchedulerTick();
    const since = Date.now() - 14 * 86_400_000;
    const items = listCarousels()
      .map((c) => ({ c, s: scheduleSummary(c) }))
      .filter(({ s }) => s && (s.status === "scheduled" || s.status === "queued" || s.status === "publishing" || s.status === "uncertain" || s.status === "missed" || s.status === "failed" || Date.parse(s.runAt) >= since))
      .map(({ c, s }) => ({ carouselId: c.id, title: c.title, cover: c.slides[0]?.render?.file ?? null, ...s! }))
      .sort((a, b) => a.runAt.localeCompare(b.runAt));
    return ok({ schedules: items });
  } catch (e) {
    return fail(e);
  }
}
