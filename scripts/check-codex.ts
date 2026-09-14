import fs from "node:fs";

async function main() {
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  const { codexExecutable } = await import("../lib/codexLlm");
  const { mediaEngine, mediaComplete, mediaVision, parseJson } = await import("../lib/mediaLlm");
  const { ledger } = await import("../lib/costLedger");
  console.log({ executable: codexExecutable(), script: mediaEngine("Script Generation"), story: mediaEngine("AI Film Story") });
  if (!process.argv.includes("--live")) return;
  if (mediaEngine("Script Generation").transport !== "codex") throw new Error("Для проверки требуется MEDIA_LLM_TRANSPORT=codex");
  const text = await mediaComplete({ stage: "Script Generation", system: 'Верни только JSON {"ok":true,"language":"русский"}.', user: "Проверка подключения Gudini, без сценария и без генерации видео." });
  const json = parseJson<{ ok: boolean; language: string }>(text, "Codex smoke");
  if (json.ok !== true || json.language !== "русский") throw new Error("Некорректный ответ теста подключения");
  console.log("Codex: текст и JSON проверены", ledger());
  if (process.argv.includes("--vision")) {
    const raw = await mediaVision({ stage: "Vision Verification", system: 'Определи цвет изображения. Верни только JSON {"color":"red|green|blue|other"}.', user: "Назови основной цвет приложенного изображения.",
      image: { base64: fs.readFileSync(process.argv[process.argv.indexOf("--vision") + 1]).toString("base64"), mediaType: "image/png" } });
    const vision = parseJson<{ color: string }>(raw, "Codex vision smoke");
    if (vision.color !== "red") throw new Error("Codex vision: красный тестовый кадр не распознан");
    console.log("Codex vision:", vision);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
