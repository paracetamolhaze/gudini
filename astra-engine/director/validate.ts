import ts from "typescript";

/** Blocks Astra may use, with the time props each one takes. */
const BLOCKS: Record<string, { time: "range" | "at" | "none" }> = {
  AstraVideo: { time: "none" },
  Captions: { time: "none" },
  BehindText: { time: "range" },
  Title: { time: "range" },
  Tag: { time: "range" },
  SidePanel: { time: "range" },
  FocusCard: { time: "range" },
  IconPop: { time: "range" },
  ImageCard: { time: "range" },
  Arrow: { time: "range" },
  Flash: { time: "at" },
  Sfx: { time: "at" },
  Music: { time: "none" },
  Logo: { time: "range" },
  Photo: { time: "range" },
  MapFocus: { time: "range" },
  Notification: { time: "range" },
  CameraView: { time: "range" },
  Scene: { time: "range" },
  Morph: { time: "range" },
  Meme: { time: "range" },
};
const HEAVY = new Set(["SidePanel", "FocusCard", "ImageCard", "Photo", "MapFocus", "Scene", "Meme", "Morph"]);
const VISUAL = new Set(["BehindText", "Title", "Tag", "SidePanel", "FocusCard", "IconPop", "ImageCard", "Arrow", "Flash",
  "Logo", "Photo", "MapFocus", "Notification", "CameraView", "Scene", "Meme", "Morph"]);
const EMOJI = /\p{Extended_Pictographic}/u;

/** Emoji and logos to fetch, photos to find, scenes to generate, morphs to make, memes to take from the library. */
export function assetNeeds(blocks: Block[]) {
  const emoji = new Set<string>(), logos = new Set<string>(), photos = new Set<string>(), scenes = new Set<string>(), memes = new Set<string>();
  const looks: Record<string, string> = {};
  const morphs: { from: number; into: string }[] = [];
  const icon = (value: unknown) => {
    if (typeof value !== "string" || !value) return;
    if (EMOJI.test(value)) emoji.add(value);
    else if (!/[./:]/.test(value)) logos.add(value);
  };
  for (const b of blocks) {
    if (b.type === "IconPop") icon(b.props.emoji);
    if (b.type === "Notification") icon(b.props.icon);
    if (b.type === "Logo" && typeof b.props.name === "string") logos.add(b.props.name);
    if (b.type === "Photo" && typeof b.props.query === "string") {
      photos.add(b.props.query);
      if (typeof b.props.look === "string") looks[b.props.query] = b.props.look;
    }
    if (b.type === "Scene" && typeof b.props.prompt === "string") scenes.add(b.props.prompt);
    if (b.type === "Morph" && typeof b.props.into === "string") morphs.push({ from: b.from, into: b.props.into });
    if (b.type === "Meme" && typeof b.props.name === "string") memes.add(b.props.name);
    for (const item of (Array.isArray(b.props.items) ? b.props.items : []) as { icon?: unknown }[]) icon(item?.icon);
  }
  return { emoji: [...emoji], logos: [...logos], photos: [...photos], looks, scenes: [...scenes], morphs, memes: [...memes] };
}
const FORBIDDEN = new Set(["fetch", "eval", "Function", "require", "XMLHttpRequest", "WebSocket", "window", "document",
  "globalThis", "process", "navigator", "localStorage", "sessionStorage", "setTimeout", "setInterval", "Date"]);

export type Block = { type: string; from: number; to: number; props: Record<string, unknown> };
export type CameraMove = { kind: string; args: number[] };
export type Analysis = { blocks: Block[]; camera: CameraMove[]; captions: number; problems: string[]; notes: string[] };

function literal(node: ts.Expression | undefined): unknown {
  if (!node) return undefined;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(e => literal(e));
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const p of node.properties) if (ts.isPropertyAssignment(p)) out[p.name.getText()] = literal(p.initializer);
    return out;
  }
  if (ts.isParenthesizedExpression(node)) return literal(node.expression);
  return undefined;
}

/** Static checks of a montage file: allowed imports and APIs, literal timings, a sane timeline. */
export function analyzeMontage(code: string, duration: number): Analysis {
  const source = ts.createSourceFile("Montage.tsx", code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  const notes: string[] = [];
  const blocks: Block[] = [];
  const camera: CameraMove[] = [];
  let captions = 0;
  let exportsMontage = false;

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const from = (node.moduleSpecifier as ts.StringLiteral).text;
      if (from !== "react" && from !== "../kit") problems.push(`Импорт из «${from}»: монтаж импортирует только react и ../kit.`);
    }
    if (ts.isVariableStatement(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (node.declarationList.declarations.some(d => d.name.getText() === "Montage")) exportsMontage = true;
    }
    if (ts.isIdentifier(node) && FORBIDDEN.has(node.text)) problems.push(`«${node.text}» недоступен в монтаже: время и данные приходят только из расшифровки.`);
    if (ts.isPropertyAccessExpression(node) && node.getText() === "Math.random") problems.push("Math.random делает кадры разными при каждом рендере; используй конкретные числа.");
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) problems.push("Динамический import недоступен.");
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText() === "cam") {
      const args = node.arguments.map(a => literal(a));
      const numbers = args.filter((a): a is number => typeof a === "number");
      camera.push({ kind: node.expression.name.text, args: numbers });
    }
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText();
      if (tag === "React.Fragment" || tag === "Fragment") { /* grouping only */ }
      else if (!(tag in BLOCKS)) problems.push(`<${tag}> — такого кубика нет. Доступны: ${Object.keys(BLOCKS).join(", ")}.`);
      else {
        const props: Record<string, unknown> = {};
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) { problems.push(`<${tag}>: разворот {...props} недоступен, пиши свойства явно.`); continue; }
          const name = attr.name.getText();
          const init = attr.initializer;
          props[name] = !init ? true : ts.isStringLiteral(init) ? init.text : ts.isJsxExpression(init) ? literal(init.expression) : undefined;
        }
        if (tag === "Captions") captions++;
        const kind = BLOCKS[tag].time;
        if (kind === "range") {
          const from = props.from, to = props.to;
          if (typeof from !== "number" || typeof to !== "number") problems.push(`<${tag}>: from и to — числа секунд прямо в разметке.`);
          else blocks.push({ type: tag, from, to, props });
        } else if (kind === "at") {
          const at = props.at;
          if (typeof at !== "number") problems.push(`<${tag}>: at — число секунд прямо в разметке.`);
          else blocks.push({ type: tag, from: at, to: at + (tag === "Flash" ? 0.25 : 0.5), props });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (!exportsMontage) problems.push("Файл экспортирует `export const Montage`.");
  if (captions !== 1) problems.push(`Нужен ровно один <Captions>, сейчас ${captions}.`);

  for (const b of blocks) {
    if (b.to <= b.from) problems.push(`<${b.type}> ${b.from}–${b.to}: конец раньше начала.`);
    if (b.from < -0.01 || b.to > duration + 0.3) problems.push(`<${b.type}> ${b.from}–${b.to}: за пределами ролика 0–${duration.toFixed(2)} с.`);
    if (b.type === "BehindText" && typeof b.props.text === "string" && b.props.text.replace(/\s/g, "").length > 14) problems.push(`<BehindText text="${b.props.text}">: до 14 букв, иначе слово станет мелким.`);
    for (const item of (Array.isArray(b.props.items) ? b.props.items : []) as { at?: unknown }[]) {
      if (typeof item?.at === "number" && (item.at < b.from - 0.05 || item.at > b.to)) problems.push(`<${b.type}> ${b.from}–${b.to}: пункт с at=${item.at} вне сцены.`);
    }
  }
  const morphs = blocks.filter(b => b.type === "Morph");
  if (morphs.length > 1) problems.push(`Превращений ${morphs.length}: превращение звучит один раз за ролик — в момент, где действие ИИ можно показать (звонит в полицию — робот с телефоном у уха). Оставь одно.`);
  const banners = blocks.filter(b => b.type === "Notification").sort((a, b) => a.from - b.from);
  banners.forEach((n, i) => {
    const next = banners[i + 1];
    if (next && next.from - n.to < 1.5) problems.push(`Уведомления ${n.from}–${n.to} и ${next.from}–${next.to} идут подряд: одно сообщение — одно уведомление, оно держится, пока автор его пересказывает. Объедини их в одно.`);
  });
  for (const m of morphs) {
    if (m.to - m.from > 2.5) problems.push(`<Morph> ${m.from}–${m.to}: превращение держится 1–2.5 секунды, иначе застывший кадр заметен.`);
  }
  const heavy = blocks.filter(b => HEAVY.has(b.type)).sort((a, b) => a.from - b.from);
  heavy.forEach((b, i) => {
    const next = heavy[i + 1];
    if (next && next.from < b.to - 0.05 && !(b.type === "ImageCard" && b.props.pos === "full")) problems.push(`<${b.type}> ${b.from}–${b.to} и <${next.type}> ${next.from}–${next.to} идут одновременно: крупные сцены — по очереди.`);
  });
  const moves = camera.map(m => ({ ...m, start: m.args[0] ?? 0, end: m.kind === "punch" || m.kind === "reset" ? m.args[0] ?? 0 : m.args[1] ?? m.args[0] ?? 0 })).sort((a, b) => a.start - b.start);
  moves.forEach((m, i) => { const n = moves[i + 1]; if (n && n.start < m.end - 0.01) problems.push(`Камера: cam.${m.kind} до ${m.end} с и cam.${n.kind} с ${n.start} с пересекаются.`); });

  // Rhythm notes guide the review; they are not hard errors.
  const visual = blocks.filter(b => VISUAL.has(b.type)).flatMap(b => [b.from,
    ...((Array.isArray(b.props.items) ? b.props.items : []) as { at?: unknown }[]).flatMap(item => (typeof item?.at === "number" ? [item.at] : []))]);
  const cuts = moves.map(m => m.start);
  const events = [...visual, ...cuts].sort((a, b) => a - b);
  if (!events.length || events[0] > 1.0) notes.push("В первую секунду нет визуального события: крючку нужен кадр с движением или словом.");
  let prev = 0;
  for (const t of [...events, duration]) {
    if (t - prev > 5) notes.push(`${prev.toFixed(1)}–${t.toFixed(1)} с: ${(t - prev).toFixed(1)} с без нового визуального события.`);
    prev = Math.max(prev, t);
  }
  return { blocks, camera, captions, problems, notes };
}

/** Time ranges that need the author cut out (text behind the author), padded and merged. */
export function cutoutRanges(blocks: Block[], duration: number): { from: number; to: number }[] {
  const ranges = blocks.filter(b => b.type === "BehindText" || (b.type === "Logo" && b.props.pos === "behind"))
    .map(b => ({ from: Math.max(0, b.from - 0.1), to: Math.min(duration, b.to + 0.1) }))
    .sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 0.5) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}
