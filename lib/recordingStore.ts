/**
 * Локальная копия записи на телефоне (IndexedDB браузера).
 *
 * Запись с телесуфлёра рождается в памяти страницы Safari, а сервер — другой
 * компьютер: файл нужно передать. Один раз загрузка оборвалась на 80 МБ, страница
 * отдала ошибку и отпустила файл — записи не осталось ни на телефоне, ни на сервере.
 * Теперь сразу после остановки запись кладётся сюда, переживает ошибку сети и
 * перезагрузку страницы, и удаляется только после успешной загрузки.
 */

export type StoredRecording = { projectId: string; blob: Blob; name: string; at: string };

const DB_NAME = "gudini-recordings";
const STORE = "recordings";

function hasIdb(): boolean {
  return typeof indexedDB !== "undefined";
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "projectId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB недоступна"));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB: ошибка запроса"));
        t.oncomplete = () => db.close();
      }),
  );
}

export async function saveRecording(projectId: string, blob: Blob, name: string): Promise<boolean> {
  if (!hasIdb()) return false;
  try {
    await tx("readwrite", (s) => s.put({ projectId, blob, name, at: new Date().toISOString() } as StoredRecording));
    return true;
  } catch {
    return false;
  }
}

export async function loadRecording(projectId: string): Promise<StoredRecording | null> {
  if (!hasIdb()) return null;
  try {
    const r = await tx<StoredRecording | undefined>("readonly", (s) => s.get(projectId) as IDBRequest<StoredRecording | undefined>);
    return r && r.blob && r.blob.size > 0 ? r : null;
  } catch {
    return null;
  }
}

export async function deleteRecording(projectId: string): Promise<void> {
  if (!hasIdb()) return;
  try {
    await tx("readwrite", (s) => s.delete(projectId));
  } catch {}
}

/**
 * Отдать запись пользователю: на телефоне — через системное меню «Поделиться»
 * (там есть «Сохранить видео» в Фото), иначе — обычное скачивание файла.
 */
export async function shareOrDownload(blob: Blob, name: string): Promise<"shared" | "downloaded" | "unsupported"> {
  if (typeof navigator === "undefined" || typeof document === "undefined") return "unsupported";
  const file = new File([blob], name, { type: blob.type || "video/mp4" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (typeof nav.share === "function" && (!nav.canShare || nav.canShare({ files: [file] }))) {
    try {
      await nav.share({ files: [file], title: name });
      return "shared";
    } catch {
      // отмена пользователем или запрет — ниже обычное скачивание
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}
