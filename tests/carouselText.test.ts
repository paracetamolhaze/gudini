import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captionProblems,
  cleanCaption,
  cleanText,
  composeCaption,
  emphasisParts,
  escapeHtml,
  normalizeHashtags,
  splitTrailingHashtags,
  tooSimilar,
  typograph,
} from "../lib/carousel/text";
import { instagramImageProblems, jpegInfo } from "../lib/carousel/jpeg";
import { buildZip, crc32 } from "../lib/carousel/zip";
import { parseCreateRequest } from "../lib/carousel/request";

const NBSP = String.fromCharCode(160);

function fakeJpeg(width: number, height: number, extra = 0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(extra), Buffer.from([0xff, 0xd9])]);
}

test("карточка: без эмодзи и управляющих символов, рубль словом", () => {
  assert.equal(cleanText(`Привет 🔥  мир${String.fromCharCode(7)}`), "Привет мир");
  assert.equal(cleanText("Стоит 500₽"), "Стоит 500 руб.");
  assert.equal(cleanText("  строка\nвторая  "), "строка вторая");
  assert.equal(cleanText("строка\n\n\n\nвторая", { multiline: true }), "строка\n\nвторая");
  // в подписи эмодзи остаются
  assert.equal(cleanCaption("Привет 🔥\r\nмир  "), "Привет 🔥\nмир");
});

test("типографика: короткие слова, тире и числа не отрываются", () => {
  assert.equal(typograph("Я и ты - в деле, 5 шагов", "ru"), `Я${NBSP}и ты${NBSP}— в${NBSP}деле, 5${NBSP}шагов`);
  assert.equal(typograph("Вы не ленивые - вам страшно", "ru"), `Вы${NBSP}не ленивые${NBSP}— вам страшно`);
  assert.equal(typograph("It is - ok", "en"), `It is${NBSP}— ok`);
});

test("акцент двойными звёздочками, непарные звёздочки — просто текст", () => {
  assert.deepEqual(emphasisParts("Как **выспаться** за ночь"), [
    { text: "Как ", hl: false },
    { text: "выспаться", hl: true },
    { text: " за ночь", hl: false },
  ]);
  assert.deepEqual(emphasisParts("a ** b"), [{ text: "a  b", hl: false }]);
});

test("экранирование HTML", () => {
  const html = escapeHtml(`<script>alert('x')</script> & "q"`);
  assert.ok(!html.includes("<script"));
  assert.equal(html, "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;q&quot;");
});

test("хэштеги: без повторов, без мусора и чисел", () => {
  assert.deepEqual(normalizeHashtags(["#Сон", "сон", "#health tips", "#123", "#здоровье!"]), ["#Сон", "#health", "#tips", "#здоровье"]);
  assert.equal(normalizeHashtags(Array.from({ length: 40 }, (_, i) => `#tag${i}`)).length, 30);
  assert.deepEqual(splitTrailingHashtags("Текст\n\n#один #два"), { caption: "Текст", tags: ["#один", "#два"] });
  assert.deepEqual(splitTrailingHashtags("Без тегов"), { caption: "Без тегов", tags: [] });
});

test("подпись: состав и пределы Instagram", () => {
  assert.equal(composeCaption("Текст", ["#a", "#b"]), "Текст\n\n#a #b");
  assert.deepEqual(captionProblems("Текст", ["#a"]), []);
  assert.match(captionProblems("x".repeat(2190), ["#abc", "#def"]).join(), /2200/);
  assert.match(captionProblems("@a @b @c @d @e @f @g @h @i @j @k @l @m @n @o @p @q @r @s @t @u", []).join(), /упоминаний 21/);
});

test("повтор другими словами распознаётся, разные мысли — нет", () => {
  assert.equal(tooSimilar("Ложитесь спать в одно и то же время", "Ложитесь спать в одно время каждый день"), true);
  assert.equal(tooSimilar("Уберите телефон за час до сна", "Проветрите спальню перед сном"), false);
});

test("JPEG: размер из заголовка и проверка под Instagram", () => {
  assert.deepEqual(jpegInfo(fakeJpeg(1080, 1350)), { width: 1080, height: 1350 });
  assert.deepEqual(instagramImageProblems(fakeJpeg(1080, 1350)), []);
  assert.deepEqual(instagramImageProblems(fakeJpeg(1080, 1080)), []);
  assert.match(instagramImageProblems(fakeJpeg(1080, 1920)).join(), /соотношение/);
  assert.match(instagramImageProblems(fakeJpeg(2000, 2000)).join(), /ширина/);
  assert.deepEqual(instagramImageProblems(Buffer.from("PNG!")), ["файл не JPEG"]);
});

test("ZIP: заголовки, число файлов и контрольная сумма", () => {
  assert.equal(crc32(Buffer.from("abc")), 0x352441c2);
  const zip = buildZip([
    { name: "01.jpg", data: Buffer.from("abc") },
    { name: "caption.txt", data: Buffer.from("Привет", "utf8") },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  const centralOffset = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt32LE(centralOffset), 0x02014b50);
  assert.equal(zip.readUInt32LE(centralOffset + 16), 0x352441c2);
});

test("форма создания: значения по умолчанию и пределы", () => {
  const ok = parseCreateRequest({ idea: "Как высыпаться" });
  assert.ok("request" in ok);
  if ("request" in ok) assert.deepEqual(ok.request, { idea: "Как высыпаться", wishes: "", slideCount: 7, language: "ru", style: "graphite", format: "portrait" });
  assert.ok("error" in parseCreateRequest({ idea: "" }));
  const tooMany = parseCreateRequest({ idea: "Тема", slideCount: 11 });
  assert.ok("error" in tooMany && /10/.test(tooMany.error));
  assert.ok("error" in parseCreateRequest({ idea: "Тема", slideCount: 2 }));
  assert.ok("error" in parseCreateRequest({ idea: "Тема", style: "neon" }));
  assert.ok("error" in parseCreateRequest({ idea: "Тема", format: "story" }));
});
