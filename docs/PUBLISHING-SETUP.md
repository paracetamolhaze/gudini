# Адреса и публикация на платформы

Сайт живёт по адресу **https://gudinijr.duckdns.org** (Docker на вашем компьютере, Caddy, DuckDNS).
Этот документ — что изменить после переезда с Railway и что нужно, чтобы ролик уходил на
платформы сразу с заголовком, описанием, хэштегами и обложкой.

## 1. Где живёт адрес сайта

| Где | Что должно стоять | Зачем |
|---|---|---|
| `.env` → `SITE_URL` | `https://gudinijr.duckdns.org` | compose передаёт его сайту как `PUBLIC_BASE_URL`; по нему Instagram скачивает видео и обложку |
| Настройки → «Публичный URL сервера» | пусто или тот же адрес | значение из настроек перекрывает `.env`; старый адрес Railway здесь ломает Instagram |
| OAuth callback | строится сам из домена, с которого открыта страница | подключать аккаунты только через `https://gudinijr.duckdns.org/settings`, не через localhost |

Callback-адреса, которые нужны в консолях платформ (ровно так, с `https` и без слэша в конце):

```
https://gudinijr.duckdns.org/api/auth/youtube/callback
https://gudinijr.duckdns.org/api/auth/tiktok/callback
https://gudinijr.duckdns.org/api/auth/instagram/callback
```

Старый адрес `gudini-production.up.railway.app` везде удалить: Railway лучше остановить совсем,
чтобы не путаться и не платить.

## 2. Что уже уходит на платформы и что нужно включить

| | Заголовок | Описание + хэштеги | Обложка | Публикуется сразу |
|---|---|---|---|---|
| YouTube Shorts | да | да, хэштеги ещё и тегами | своя картинка, если канал верифицирован по телефону | по настройке `YOUTUBE_PRIVACY` |
| TikTok | в подписи | в подписи | только кадр из видео по таймкоду (свою картинку API не принимает) | по настройке `TIKTOK_DIRECT_POST`, после аудита приложения |
| Instagram Reels | в подписи | в подписи | своя картинка по ссылке | да |

### YouTube

1. **Google Cloud Console → APIs & Services → Credentials → ваш OAuth client (Web).**
   В «Authorized redirect URIs» оставить только callback выше. В «Authorized JavaScript origins» —
   `https://gudinijr.duckdns.org`.
2. **OAuth consent screen.** Пока приложение в режиме Testing, refresh-токен живёт 7 дней и
   аккаунт придётся переподключать каждую неделю. Нажмите «Publish app»: при входе появится экран
   «непроверенное приложение», для своего аккаунта его можно пройти («Дополнительно → перейти»).
3. **Верификация канала по телефону** (youtube.com/verify) — без неё YouTube отказывает в своей
   обложке (403), видео при этом заливается.
4. **Сразу в общий доступ:** в `.env` добавить `YOUTUBE_PRIVACY=public` (или `unlisted`) и
   пересоздать сайт. По умолчанию `private`: приватный черновик, публикуется из YouTube Studio.
   Вертикальный ролик до 3 минут YouTube сам считает Shorts.

### TikTok

Сейчас ролик уходит в черновики (Уведомления → Загрузки), подпись и обложку выбираете в приложении.
Чтобы публиковалось сразу с подписью:

1. **developers.tiktok.com → приложение → Login Kit:** Redirect URI — callback выше.
   «Web» → URL сайта `https://gudinijr.duckdns.org`. Scopes: `user.info.basic`, `video.upload`, `video.publish`.
2. **Products → Content Posting API → включить Direct Post** и **подать приложение на аудит**
   (App review): нужны название, описание, иконка, ссылка на политику конфиденциальности и
   условия (можно страницы сайта), демо-видео, как ролик публикуется из Gudini. До одобрения
   TikTok разрешает только видимость SELF_ONLY: ролик увидите только вы — Gudini так и напишет
   в сообщении публикации.
3. Domain verification нужна только для загрузки по ссылке (PULL_FROM_URL); Gudini шлёт файл
   напрямую, поэтому не обязательна. Если всё же включаете: переменная `TIKTOK_VERIFY_CONTENT`
   в `.env` отдаёт файл проверки `tiktok*.txt` с корня сайта.
4. В `.env`: `TIKTOK_DIRECT_POST=1`, при желании `TIKTOK_PRIVACY=PUBLIC_TO_EVERYONE`
   (варианты: `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`, `SELF_ONLY`). Пересоздать сайт.
5. Обложка: TikTok берёт кадр по таймкоду обложки проекта (`coverOffsetSec`, по умолчанию 1 с).
   Своя картинка через API невозможна — только вручную в приложении.

### Instagram Reels

Уже публикуется сразу с подписью (заголовок, описание, хэштеги) и своей обложкой. Условия:

1. Аккаунт Instagram — **профессиональный** (Business или Creator).
2. **Meta for Developers → приложение → Instagram → «API setup with Instagram business login»:**
   Business login settings → OAuth Redirect URIs — callback выше. Settings → Basic → App Domains —
   `gudinijr.duckdns.org`, Privacy Policy URL — любая страница с политикой.
3. Разрешения `instagram_business_basic` и `instagram_business_content_publish`. Для своего
   аккаунта хватает режима Development с ролью Instagram Tester (Roles → Instagram Testers, принять
   приглашение в приложении Instagram). App Review нужен только для чужих аккаунтов.
4. Сайт должен быть доступен снаружи в момент публикации: Instagram скачивает видео и обложку по
   ссылкам `…/video?which=processed` и `…/video?which=cover`. Эти адреса открыты даже при включённом
   пароле сайта.
5. Токен живёт 60 дней и продлевается сам; если публикация ругается на аккаунт — переподключить
   Instagram в Настройках.

## 3. Порядок действий одной строкой

1. В консолях трёх платформ заменить адреса Railway на `https://gudinijr.duckdns.org` и callback выше.
2. Остановить Railway.
3. Открыть `https://gudinijr.duckdns.org/settings` и переподключить все три аккаунта.
4. В `.env`: `YOUTUBE_PRIVACY=public`, `TIKTOK_DIRECT_POST=1`; выполнить
   `docker compose --profile public up -d gudini-site`.
5. YouTube: опубликовать OAuth-приложение и верифицировать канал по телефону.
6. TikTok: подать приложение на аудит Content Posting API; до одобрения ролики идут как SELF_ONLY.
7. Проверить на одном ролике: кнопка «Опубликовать» на шаге 4 для каждой платформы; сообщение под
   кнопкой говорит, что именно ушло, а чего платформа не приняла.
