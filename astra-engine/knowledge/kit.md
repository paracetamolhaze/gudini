# Кубики монтажа

Файл `Montage.tsx` импортирует только `react` и `../kit` и экспортирует `Montage`. Все времена — секунды от начала ролика, числами прямо в разметке. Координаты — пиксели кадра 1080×1920.

```tsx
import React from "react";
import { AstraVideo, cam, Captions, BehindText, MapFocus, Logo, Photo, Illustration, Meme, IconPop, Notification, CameraView, SidePanel, FocusCard, Sfx, Music } from "../kit";

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
<MapFocus from to region="usa|world" lat={36.7} lon={-119.4} label="Калифорния" highlight="California" zoom? />
```

Карта на весь кадр: летит от всей страны или мира к месту, подсвечивает штат или страну, ставит точку с подписью. 2.5–4 секунды.

### Logo

```tsx
<Logo from to name="Waymo" pos="above|behind" size? />
```

Логотип компании, сервиса или монеты на белой плитке: над головой автора или крупно за его спиной.

### Photo

```tsx
<Photo from to query="gel blaster" look="игрушечный бластер и рядом гелевые шарики" pos="lower|full" fallback? />
```

Настоящее фото. `query` — 2–4 английских слова для фотостока, `look` — что обязательно должно быть видно: по нему выбирается лучшее фото. `lower` — карточка поверх нижней части кадра, `full` — перебивка на весь кадр.

### Illustration

```tsx
<Illustration from to prompt="a white robotaxi, colorful gel beads flying out of its open windows" pos="lower|full" />
```

Нарисованная мультяшная сцена в едином стиле ролика (стиль добавляется сам). Одна понятная сцена, без надписей и без людей с оружием. Рисуется до рендера примерно за минуту.

### Meme

```tsx
<Meme from to name="имя-из-списка" pos="lower|full|corner" volume={0} />
```

Короткий мем из библиотеки владельца (список — в задании), по умолчанию без звука.

### IconPop

```tsx
<IconPop from to emoji="🤖" x y size={220} />
```

Объёмная 3D-иконка. Уместна как знак робота, ИИ, голосового помощника.

### Notification

```tsx
<Notification from to app="Waymo" icon="Waymo" title="Обнаружена неисправность" text="Машина заедет на парковку" time? />
```

Уведомление как на телефоне: сообщения, системные предупреждения, слова поддержки. `icon` — название бренда или 🤖.

### CameraView

```tsx
<CameraView from to />
```

Автор превращается в запись камеры наблюдения: чёрно-белый контрастный кадр, REC, время, рамка.

### ImageCard

```tsx
<ImageCard from to src="asset-name" pos="lower|full" caption? tilt? fit? />
```

Фото или скриншот из материалов ролика.

## Списки и выводы

### SidePanel

```tsx
<SidePanel from to title="Что взяли" numbered? items={[{ text, at, icon? }]} />
```

Список поверх нижней части кадра, без фона. Все пункты белые; пункт, который автор называет, подсвечивается в момент `at`, подсветка переходит дальше. `icon` — по желанию, название бренда или картинка из материалов.

### FocusCard

```tsx
<FocusCard from to title="Итог" numbered? items={[{ text, at }]} />
```

Карточка во весь кадр на тёмном фоне, автор в кружке справа сверху, пункты подсвечиваются по речи.

## Текст

### BehindText

```tsx
<BehindText from to text="ТЕРМИН" y? color? />
```

Огромное слово за головой автора, до 14 букв; субтитр в этот момент сам прячется. `color`: оранжевый по умолчанию, `"highlight"` — жёлтый, `"text"` — белый.

### Title

```tsx
<Title from to text="мысль между строк" box? />
```

Кинетический заголовок над головой, 2–4 слова.

### Tag

```tsx
<Tag from to text="ЭТАП 1" tone="blue|accent|dark" />
```

Плашка раздела в углу.

### Captions

```tsx
<Captions style="clean|bold|minimal" emphasis={[индексы]} placements? hidden? />
```

Одно слово по центру в момент произнесения. Ставится последним.

## Акценты и звук

- `<Arrow from to x1 y1 x2 y2 label="коротко" />` — стрелка от руки, остриё в (x2, y2).
- `<Flash at />` — вспышка на кульминации.
- `<Sfx at role="whoosh|pop|click|typing|ding|error|cash|notification|riser|impact|glitch|swipe|shutter|tick" volume={0.55} />` — отдельный звуковой эффект.
- `<Music mood="calm|curious|upbeat|tense|dramatic|playful" />` — музыкальная подложка, сама стихает под голос.

`sfx={false}` у любого кубика выключает его встроенный звук, `sfx="ding"` заменяет его.
