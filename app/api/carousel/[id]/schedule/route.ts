import { NextRequest } from "next/server";
import { fail, guard, ok, readBody } from "@/lib/carousel/http";
import { findInstagramAccount, instagramAccountInfo, toPublishAccount } from "@/lib/carousel/account";
import { cancelSchedule, refreshScheduleSnapshot, setSchedule } from "@/lib/carousel/schedule";
import { toClient } from "@/lib/carousel/view";
import { DEFAULT_TIME_ZONE } from "@/lib/carousel/timezone";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Отложенная публикация: назначить или перенести (localTime + timeZone + accountId + revision),
 * обновить снимок одобренной версии после правок (action=refresh). Аккаунт закрепляется
 * здесь, время хранится в UTC.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = await readBody(req);
    if (body.action === "refresh") return ok(toClient(refreshScheduleSnapshot(id, body.revision)));

    const chosen = findInstagramAccount(typeof body.accountId === "string" ? body.accountId : null);
    const info = instagramAccountInfo(chosen?.id ?? null);
    if (!chosen || info.problems.length) return ok({ error: info.problems.join(" ") || "Аккаунт Instagram не выбран", code: "instagram_unavailable" }, 400);
    const c = setSchedule(id, {
      localTime: String(body.localTime ?? ""),
      timeZone: typeof body.timeZone === "string" && body.timeZone ? body.timeZone : DEFAULT_TIME_ZONE,
      account: toPublishAccount(chosen),
      revision: body.revision,
    });
    return ok(toClient(c));
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    return ok(toClient(cancelSchedule(id)));
  } catch (e) {
    return fail(e);
  }
}
