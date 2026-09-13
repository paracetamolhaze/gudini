import { NextRequest } from "next/server";
import { guard, ok } from "@/lib/carousel/http";
import { instagramAccountInfo, listInstagramAccounts } from "@/lib/carousel/account";
import { CAROUSEL_LIMITS, IG_LIMITS } from "@/lib/carousel/limits";
import { runnerState } from "@/lib/carousel/runnerControl";
import { budgetLimits, carouselApiKey, configProblems, defaultImageModel, imageResolution, KEY_ENV, textModel } from "@/lib/carousel/config";
import { IMAGE_MODELS, IMAGE_MODEL_IDS, MODELS_CHECKED_AT, imageEstimate, requestResolution, textEstimate } from "@/lib/carousel/models";
import { keyInfo, modelCatalog, redactSecrets, type KeyInfo } from "@/lib/carousel/openrouter";
import { budgetStatus } from "@/lib/carousel/spend";
import { readDesign } from "@/lib/carousel/design";
import { COMMON_TIME_ZONES, DEFAULT_TIME_ZONE } from "@/lib/carousel/timezone";

export const dynamic = "force-dynamic";

/** Лимит ключа читается не чаще раза в минуту: это запрос к OpenRouter на каждый показ страницы. */
let keyCache: { at: number; value: KeyInfo | null; error: string | null } | null = null;

async function keyState(): Promise<{ info: KeyInfo | null; error: string | null }> {
  if (!carouselApiKey()) return { info: null, error: null };
  if (keyCache && Date.now() - keyCache.at < 60_000) return { info: keyCache.value, error: keyCache.error };
  try {
    const value = await keyInfo();
    keyCache = { at: Date.now(), value, error: null };
    return { info: value, error: null };
  } catch (e: any) {
    const error = redactSecrets(String(e?.message ?? e)).slice(0, 200);
    keyCache = { at: Date.now(), value: null, error };
    return { info: null, error };
  }
}

/** Доступность моделей по публичному каталогу OpenRouter: нет в каталоге или нет нужного соотношения — недоступна, подмены нет. */
async function modelAvailability() {
  let catalog: Awaited<ReturnType<typeof modelCatalog>> | null = null;
  let catalogError: string | null = null;
  try {
    catalog = await modelCatalog("images");
  } catch (e: any) {
    catalogError = redactSecrets(String(e?.message ?? e)).slice(0, 160);
  }
  return IMAGE_MODEL_IDS.map((id) => {
    const m = IMAGE_MODELS[id];
    let available: boolean | null = null;
    let reason: string | null = null;
    if (catalog) {
      const entry = catalog.get(id);
      if (!entry) {
        available = false;
        reason = "модели сейчас нет в каталоге OpenRouter";
      } else {
        const aspects: unknown[] = entry.params?.aspect_ratio?.values ?? [];
        const need = m.aspect.portrait;
        if (aspects.length && !aspects.includes(need)) {
          available = false;
          reason = `модель не принимает соотношение ${need}`;
        } else available = true;
      }
    } else reason = `каталог OpenRouter недоступен: ${catalogError}`;
    const resolution = requestResolution(id, imageResolution());
    return { ...m, available, reason, resolution, perImageUsd: imageEstimate(id, resolution) };
  });
}

/** Что доступно разделу: ключ (только «задан / не задан»), модели, бюджет, Instagram, оформление. Значений секретов нет. */
export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  const [key, models] = await Promise.all([keyState(), modelAvailability()]);
  const ig = instagramAccountInfo();
  const text = textModel();
  const image = defaultImageModel();
  return ok({
    config: { keyEnv: KEY_ENV, keySet: Boolean(carouselApiKey()), problems: configProblems(), textModel: text.id, imageModel: image.id, resolution: imageResolution(), budgets: budgetLimits() },
    key: key.info,
    keyError: key.error,
    models,
    modelsCheckedAt: MODELS_CHECKED_AT,
    pricing: { textPlanUsd: textEstimate(text.id, "plan") * 1.5, textEditUsd: textEstimate(text.id, "edit") },
    budget: budgetStatus(),
    instagram: { connected: ig.connected, label: ig.label, via: ig.via, expiresInDays: ig.expiresInDays, problems: ig.problems, accounts: listInstagramAccounts() },
    design: readDesign(),
    timeZone: DEFAULT_TIME_ZONE,
    timeZones: COMMON_TIME_ZONES,
    limits: { slides: { min: CAROUSEL_LIMITS.minSlides, max: CAROUSEL_LIMITS.maxSlides, default: CAROUSEL_LIMITS.defaultSlides }, ig: IG_LIMITS },
    runner: runnerState(),
  });
}
