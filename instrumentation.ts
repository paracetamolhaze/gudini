/**
 * Старт сервера Next.js. Единственное действие — продолжить фоновые задания каруселей,
 * прерванные перезапуском или развёртыванием (lib/carousel/runnerControl.ts).
 * Ошибка здесь не мешает запуску сайта.
 *
 * Импорт стоит внутри условия по NEXT_RUNTIME, а не после раннего return: Next собирает этот
 * файл и для edge-среды, и только такое условие сборщик вырезает — иначе в edge-сборку
 * попадают fs и child_process, и падает весь сайт.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { kickRunnerOnBoot } = await import("./lib/carousel/runnerControl");
      kickRunnerOnBoot();
    } catch (e) {
      console.warn("Карусели: проверка фоновых заданий при старте не удалась:", e);
    }
  }
}
