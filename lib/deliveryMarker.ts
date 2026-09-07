import fs from "fs";
import path from "path";
import { projectDir } from "./store";

/**
 * Готовый ролик, который ещё не доставлен на сайт. Сбой сети при отправке раньше
 * приводил к новому монтажу с нуля — режиссёр и остальные платные стадии
 * оплачивались второй раз ради файла, который уже лежал на диске воркера.
 */
export type DeliveryMarker = {
  at: string;
  /** отпечаток исходника, из которого собран ролик */
  rawFingerprint: string;
  /** хэш сценария, под который собран ролик */
  scriptHash: string;
  /** поля проекта, которые уходят на сайт вместе с роликом */
  project: Record<string, unknown>;
};

export const DELIVERY_FILE = "delivery-pending.json";

/** Ролик можно просто дослать: исходник и сценарий те же, что при монтаже. */
export function canRedeliver(marker: DeliveryMarker | null, now: { rawFingerprint: string; scriptHash: string }): boolean {
  if (!marker) return false;
  return Boolean(marker.rawFingerprint) && marker.rawFingerprint === now.rawFingerprint && marker.scriptHash === now.scriptHash;
}

export function readDelivery(id: string): DeliveryMarker | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(projectDir(id), DELIVERY_FILE), "utf8"));
    return j && typeof j.rawFingerprint === "string" ? (j as DeliveryMarker) : null;
  } catch {
    return null;
  }
}

export function writeDelivery(id: string, marker: DeliveryMarker): void {
  fs.writeFileSync(path.join(projectDir(id), DELIVERY_FILE), JSON.stringify(marker, null, 2), "utf8");
}

export function clearDelivery(id: string): void {
  try {
    fs.rmSync(path.join(projectDir(id), DELIVERY_FILE), { force: true });
  } catch {}
}
