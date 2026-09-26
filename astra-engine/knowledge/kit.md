# Кубики монтажа

Файл `Montage.tsx` импортирует только `react` и `../kit` и экспортирует `Montage`. Все времена — секунды от начала ролика, числами прямо в разметке. Координаты — пиксели кадра 1080×1920.

```tsx
import React from "react";
import { AstraVideo, cam, Captions, BehindText, Title, Tag, SidePanel, FocusCard, IconPop, ImageCard, Arrow, Flash, Sfx, Music } from "../kit";

export const Montage: React.FC = () => (
  <AstraVideo camera={[cam.push(0, 3, 1.12), cam.punch(9.4, 1.2), cam.reset(12.1)]}>
    {/* кубики по порядку времени; позже в списке — выше на экране */}
    <Captions emphasis={[0, 7, 31]} />
  </AstraVideo>
);
```

## AstraVideo

Корень монтажа: автор с камерой и голос. `camera` — список движений по порядку:

- `cam.push(from, to, zoom = 1.12)` — плавный наезд;
- `cam.pull(from, to, zoom = 1)` — плавный отъезд;
- `cam.punch(at, zoom = 1.2)` — резкий панч-ин;
- `cam.reset(at)` — резкий возврат к общему плану;
- `cam.move(from, to, { zoom, x, y })` — свободное плавное движение (x, y — сдвиг в пикселях).

## Captions

`<Captions style="clean" emphasis={[индексы слов]} placements={[{ from, to, pos }]} hidden={[{ from, to }]} maxWords={3} />`

- `style`: `clean` | `bold` | `minimal`;
- `pos`: `"low"` (обычно), `"mid"`, `"high"`, `"above-panel"` или `{ y }`.

Ставится последним.

## BehindText

`<BehindText from to text="ТЕРМИН" y? color? sfx? />`

Огромное слово за головой автора. Текст до 14 букв. Цвет по умолчанию оранжевый, для второго акцента — `"highlight"` (жёлтый) или `"text"` (белый).

## Title

`<Title from to text="главная мысль" top? maxHeight? box? color? sfx? />`

Кинетический заголовок над головой, 2–6 слов, слова выезжают по очереди. `box` — плотная оранжевая плашка под текстом, для самого ударного тезиса.

## Tag

`<Tag from to text="ЭТАП 1" tone="blue|accent|dark" pos="top-left|top-center" sfx? />`

Маленькая плашка раздела в углу.

## SidePanel

`<SidePanel from to side="bottom|right" title="Как это работает" numbered? items={[{ text, at, icon?, tone? }]} sfx? />`

Разделение экрана: панель со списком, автор сдвигается. Пункт появляется в `at`. `icon` — эмодзи (`"🔫"`) или имя картинки из материалов. `tone: "accent"` — для вывода, `"good"` / `"bad"` — для плюсов и минусов.

## FocusCard

`<FocusCard from to title="Итог" numbered? items={[{ text, at, tone? }]} sfx? />`

Тёмная карточка на весь кадр, автор говорит в кружке справа сверху.

## IconPop

`<IconPop from to emoji="🚕" | src="asset-name" x y size={200} label? sfx? />`

Иконка, логотип или эмодзи с пружинкой и подписью.

## ImageCard

`<ImageCard from to src="asset-name" pos="lower|full" caption? tilt? fit="cover|contain" sfx? />`

Фото или скриншот из материалов ролика.

## Arrow

`<Arrow from to x1 y1 x2 y2 label="коротко" bend={0.3} color? sfx? />`

Стрелка от руки: подпись стоит в (x1, y1), остриё — в (x2, y2).

## Flash

`<Flash at tint? sfx? />`

Короткая вспышка на сильном ударе.

## Звук

- `<Sfx at role="whoosh|pop|click|typing|ding|error|cash|notification|riser|impact|glitch|swipe|shutter|tick" volume={0.55} />` — отдельный эффект;
- `<Music mood="calm|curious|upbeat|tense|dramatic|playful" from? to? volume={0.16} />` — подложка, сама приглушается под голос.

`sfx={false}` у любого кубика выключает его встроенный звук, `sfx="ding"` заменяет его.
