import fs from "fs";
import { NextRequest } from "next/server";
import { fail, guard, ok, readBody } from "@/lib/carousel/http";
import { attachJob, CarouselError, isJobPending, slideFilePath, updateCarousel } from "@/lib/carousel/store";
import { instagramAccountInfo } from "@/lib/carousel/account";
import { needsVerification } from "@/lib/carousel/instagram";
import { instagramImageProblems } from "@/lib/carousel/jpeg";
import { composeCaption } from "@/lib/carousel/text";
import { publishReadiness, toClient } from "@/lib/carousel/view";
import { ensureRunner } from "@/lib/carousel/runnerControl";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Публикация в Instagram — только явным действием пользователя после предпросмотра.
 * Проверка «можно ли» и постановка задания идут под одной блокировкой карусели:
 * двойное нажатие и повторный запрос получают отказ, а не вторую публикацию.
 *
 * action=verify — только проверка исхода уже отправленной публикации, без новой отправки.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = await readBody(req);
    const now = new Date().toISOString();

    if (body.action === "verify") {
      const c = updateCarousel(id, (x) => {
        if (isJobPending(x.job)) throw new CarouselError("Идёт задание — дождитесь его окончания", 409, "busy");
        if (!needsVerification(x.publish)) throw new CarouselError("Проверять нечего: публикация не отправлялась или её итог уже известен", 409, "nothing_to_verify");
        attachJob(x, "verify_publish");
        x.publish.log = [...x.publish.log, { at: now, text: "Проверка статуса поставлена в очередь" }].slice(-60);
      });
      ensureRunner();
      return ok(toClient(c), 202);
    }

    const account = instagramAccountInfo();
    if (account.problems.length) return ok({ error: account.problems.join(" "), code: "instagram_unavailable" }, 400);

    const c = updateCarousel(id, (x) => {
      const p = x.publish;
      if (isJobPending(x.job)) throw new CarouselError("Идёт задание — дождитесь его окончания", 409, "busy");
      if (p.status === "published") {
        throw new CarouselError(`Карусель уже опубликована${p.permalink ? `: ${p.permalink}` : ""}. Повторная публикация отключена, чтобы не создать дубль.`, 409, "already_published");
      }
      if (needsVerification(p)) throw new CarouselError("Исход прошлой публикации не подтверждён — сначала нажмите «Проверить статус»", 409, "verify_first");
      if (p.status === "queued" || p.status === "running") throw new CarouselError("Публикация уже выполняется", 409, "publishing");
      if (typeof body.revision !== "number" || body.revision !== x.revision) {
        throw new CarouselError("Карусель изменилась после просмотра — обновите страницу и проверьте слайды перед публикацией", 409, "stale_revision");
      }
      const problems = publishReadiness(x);
      if (problems.length) throw new CarouselError(`Карусель не готова к публикации: ${problems.join("; ")}`, 400, "not_ready");
      x.slides.forEach((s, i) => {
        const file = slideFilePath(x.id, s.render!.file!);
        if (!fs.existsSync(file)) throw new CarouselError(`Файл слайда ${i + 1} не найден — запустите рендер заново`, 409, "file_missing");
        const bad = instagramImageProblems(fs.readFileSync(file));
        if (bad.length) throw new CarouselError(`Слайд ${i + 1} не подходит Instagram: ${bad.join(", ")}`, 400, "bad_image");
      });

      const caption = composeCaption(x.caption, x.hashtags);
      // тот же набор слайдов и подпись — созданные раньше контейнеры переиспользуются
      const same =
        p.revision === x.revision &&
        p.caption === caption &&
        p.items.length === x.slides.length &&
        p.items.every((it, i) => it.slideId === x.slides[i].id && it.file === x.slides[i].render!.file);
      x.publish = {
        ...p,
        status: "queued",
        stage: undefined,
        revision: x.revision,
        caption,
        items: x.slides.map((s, i) => (same ? p.items[i] : { slideId: s.id, file: s.render!.file! })),
        containerId: same ? p.containerId : undefined,
        containerCreatedAt: same ? p.containerCreatedAt : undefined,
        publishAttempts: 0,
        error: undefined,
        note: undefined,
        retryable: undefined,
        log: [...p.log, { at: now, text: p.status === "failed" ? "Повтор публикации поставлен в очередь" : "Публикация поставлена в очередь" }].slice(-60),
      };
      attachJob(x, "publish");
    });
    ensureRunner();
    return ok(toClient(c), 202);
  } catch (e) {
    return fail(e);
  }
}
