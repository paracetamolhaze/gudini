# Кубики монтажа

Файл `Montage.tsx` импортирует только `react` и `../kit` и экспортирует `Montage`. Все времена — секунды от начала ролика, числами прямо в разметке. Координаты — пиксели кадра 1080×1920.

```tsx
import React from "react";
import { AstraVideo, cam, Captions, BehindText, MapFocus, Logo, Photo, Scene, Morph, Meme, Notification, CameraView, SidePanel, Sfx, Music } from "../kit";

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
- `cam.move(from, to, { zoom, x, y })` — свободное плавное движение.

## Показать то, о чём говорят

### MapFocus

```tsx
<MapFocus from to region="usa|world" lat={37.56} lon={-122.32} label="Калифорния" highlight="California" zoom? />
```

Карта на весь кадр: летит от всей страны или мира к месту, подсвечивает штат или страну и ставит точку с подписью. Держится 2.5–4 секунды.

### Photo

```tsx
<Photo from to query="empty car interior" look="весь салон целиком: руль и пустое водительское кресло" pos="full|lower" />
```

Реалистичное вертикальное фото одного предмета, животного или места; создаётся генератором по `look` и проверяется до рендера.
- `query` — 2–4 английских слова: короткое имя картинки.
- `look` — каким должен быть кадр: что в нём и что обязательно видно целиком.
- `full` — на весь экран, `lower` — карточка поверх нижней части кадра.

### Scene

```tsx
<Scene from to prompt="two 15-year-old boys in the back seat of a white Waymo, one leans out of the open window and shoots a black toy pistol, gel beads flying, medium shot" pos="full|lower" />
```

Реалистичная сцена самой истории, генерируется до рендера (около минуты). Описание — по-английски, как у оператора: кто в кадре и сколько их, что у них в руках, что происходит, где, какой план. Стиль — вертикальное фото, предмет крупно и целиком — добавляется сам. После генерации Астра проверяет картинку, и неверная генерируется заново.

### Morph

```tsx
<Morph from to into="a humanoid robot with a glossy white face and glowing blue eyes, holding a smartphone to its ear and talking on the phone" />
```

Автор на 1–2.5 секунды превращается в того, кто описан в `into`, и возвращается обратно с глитчем. Картинка делается из его же кадра в момент `from`, поэтому поза и комната сохраняются. Лучший момент — когда действует ИИ.

### Logo

```tsx
<Logo from to name="Waymo" pos="above|behind" size? />
```

Логотип компании, сервиса или монеты на белой плитке: над головой автора (`above`) или крупно за его спиной (`behind`).

### Meme

```tsx
<Meme from to name="имя-из-списка" pos="lower|full|corner" volume={0} />
```

Короткий мем из библиотеки владельца (список — в задании), по умолчанию без звука.

### Notification

```tsx
<Notification from to app="Waymo" icon="Waymo" title="Обнаружена неисправность" text="Машина заедет на парковку" time? />
```

Уведомление как на телефоне: сообщения, системные предупреждения, слова поддержки. `icon` — название бренда.

### CameraView

```tsx
<CameraView from to />
```

Автор превращается в запись камеры наблюдения: чёрно-белый контрастный кадр, REC, время, рамка.

### ImageCard

```tsx
<ImageCard from to src="asset-name" pos="full|lower" />
```

Картинка из материалов автора.

## Список

### SidePanel

```tsx
<SidePanel from to title? numbered? items={[{ text, at }]} />
```

Автор плавно уезжает вверх, снизу выезжает список на тёмном фоне. Все пункты белые. Пункт, который автор называет, подсвечивается в момент `at`, и подсветка переходит дальше вслед за речью. `title` — только если добавляет смысл. `numbered` — пункты цепочкой с номерами. Список, который встаёт справа от автора: `side="right"`.

## Текст

### BehindText

```tsx
<BehindText from to text="WAYMO" color? />
```

Огромное слово за головой автора, до 14 букв. Субтитр в этот момент сам прячется.
- `text` — имя, бренд или термин.
- `color`: оранжевый по умолчанию, `"highlight"` — жёлтый, `"text"` — белый.

### Title

```tsx
<Title from to text="мысль между строк" box? />
```

Кинетический заголовок над головой, 2–4 слова, для мысли, которую автор не произносит дословно. Редко.

### Tag

```tsx
<Tag from to text="ЭТАП 1" tone="blue|accent|dark" />
```

Плашка раздела в углу — для структуры ролика: «ЭТАП 1», «ЧАСТЬ 2».

### Captions

```tsx
<Captions style="clean|bold|minimal" emphasis={[индексы]} placements? hidden? />
```

Одно слово по центру в момент произнесения. Ставится последним.

## Акценты и звук

- `<Arrow from to x1 y1 x2 y2 label="коротко" />` — стрелка от руки, остриё в точке (x2, y2).
- `<Flash at />` — вспышка на кульминации.
- `<Sfx at role="impact|cash|ding|error|pop|whoosh|swipe|shutter|notification" volume? />` — звук на появление картинки: `at` совпадает с началом её блока или с панчем камеры. Громкость роли уже настроена фоном под голос; `volume` меняет её для одного звука: 0.6 — тише, 1.3 — громче.
- `<Music mood="calm|curious|upbeat|tense|dramatic|playful" />` — музыкальная подложка, сама стихает под голос.

`sfx={false}` у любого кубика выключает его встроенный звук, `sfx="ding"` заменяет его.
