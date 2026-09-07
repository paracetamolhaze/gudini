/**
 * Бесплатная проверка дорожек на входе: видео и звук должны быть одной длины.
 *
 * Запись с телесуфлёра на iPhone: Safari перестал отдавать кадры камеры через 8 с,
 * а звук писался 87 с. Контейнер при этом уверял, что видео тоже 87 с, и правда
 * вскрылась только на сверке готового ролика — после режиссёра и обложки ($0.39).
 * После нормализации (CFR 30 к/с) длительность видеодорожки честная, и такую запись
 * можно отклонить до первой платной стадии.
 */
export const TRACK_MISMATCH_TOLERANCE_SEC = 2;

export function trackMismatchError(videoDuration: number, audioDuration: number): string | null {
  if (!(videoDuration > 0) || !(audioDuration > 0)) return null;
  if (videoDuration >= audioDuration - TRACK_MISMATCH_TOLERANCE_SEC) return null;
  return (
    `Видеодорожка обрывается на ${videoDuration.toFixed(0)} с, а звук идёт ${audioDuration.toFixed(0)} с: ` +
    `браузер перестал отдавать кадры камеры во время записи. Перезапишите дубль ` +
    `(в телесуфлёре следите за счётчиком кадров) или загрузите файл с камеры. Платные стадии не запускались.`
  );
}
