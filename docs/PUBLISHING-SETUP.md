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

## 4. Уточнения после переезда (6 сентября)

- **Google, секрет клиента.** Консоль больше не показывает Client secret. Если он не сохранён,
  на странице клиента нажмите «Add secret», скопируйте новый и впишите на сайте.
- **Google, публикация приложения.** Кнопка «Publish app» неактивна, пока не заполнен Branding:
  https://console.cloud.google.com/auth/branding — имя приложения, e-mail поддержки, контакт
  разработчика. Потом https://console.cloud.google.com/auth/audience → «Publish app».
- **Meta, форма Business login settings** не сохраняется без двух служебных адресов, они есть на сайте:
  ```
  Deauthorize callback URL:   https://gudinijr.duckdns.org/api/auth/instagram/deauthorize
  Data deletion request URL:  https://gudinijr.duckdns.org/api/auth/instagram/data-deletion
  ```
  Instagram App ID и Instagram App Secret берутся со страницы «API setup with Instagram business
  login», а не из Settings → Basic (там ID и секрет приложения Meta для запасного входа через Facebook).
  В Settings → Basic адреса политики и соглашения: `https://gudinijr.duckdns.org/privacy` и
  `https://gudinijr.duckdns.org/terms`, старые адреса Railway убрать.
- **TikTok.** В Sandbox после правок нажмите «Apply changes» вверху справа. Адреса Terms of Service и
  Privacy Policy заменить на `https://gudinijr.duckdns.org/terms` и `https://gudinijr.duckdns.org/privacy`.
  Sandbox публикует только для аккаунтов из «Target users» и только с видимостью «только я»;
  для настоящих публикаций те же настройки нужно повторить во вкладке Production и подать на аудит.

## 5. Дома сайт не открывается по домену

Снаружи сайт доступен (проверено HTTP 200 с узлов в четырёх странах), но роутер не заворачивает
запрос к своему внешнему адресу обратно в домашнюю сеть. Дома сайт открывается по адресу
компьютера: `http://192.168.1.68:3000` (порт 3000 опубликован в compose). Чтобы и домен работал на
самом компьютере, добавьте строку в `C:\Windows\System32\drivers\etc\hosts` (Блокнот от
администратора): `192.168.1.68 gudinijr.duckdns.org`. Подключать аккаунты платформ нужно через
домен (с телефона по мобильному интернету или с компьютера после правки hosts): адреса возврата
OAuth строятся из домена.

## 6. Google: логотип и имя приложения

Google показывает логотип и имя на экране входа только после подтверждения, что домен домашней
страницы принадлежит вам. Это косметика: подключение YouTube работает и без него, просто на экране
входа будет предупреждение «непроверенное приложение». Чтобы подтвердить: Search Console
(https://search.google.com/search-console) → Add property → URL prefix `https://gudinijr.duckdns.org`
→ способ «HTML tag» → скопировать значение `content="…"` в `.env` как `GOOGLE_SITE_VERIFICATION`,
пересоздать сайт, нажать Verify. Затем Google Auth Platform → Verification Center → Branding →
«I have fixed the issues».

## 7. TikTok: проверка домена и экран публикации

- **Проверка URL-префикса.** TikTok даёт файл `tiktok<ТОКЕН>.txt` и просит положить его по префиксу
  (например `https://gudinijr.duckdns.org/terms/`). Токен вписывается в `.env` как
  `TIKTOK_VERIFY_CONTENT` (несколько — через запятую), сайт отдаёт файл по любому пути, но только для
  своих токенов. После `docker compose --profile public up -d gudini-site` нажать Verify.
- **Экран публикации** (`TikTokPanel` на шаге «Публикация», данные из `GET /api/projects/<id>/tiktok`):
  при `TIKTOK_DIRECT_POST=1` кнопка карточки TikTok открывает форму по правилам Direct Post —
  аккаунт, в который уйдёт ролик (creator_info), превью, редактируемая подпись до 2200 символов,
  выбор видимости из списка TikTok без значения по умолчанию, комментарии/дуэты/стичи с учётом
  запретов аккаунта, кадр обложки, пометка коммерческого контента (свой бренд / брендированный —
  последний нельзя публиковать «только для себя»), согласие с Music Usage Confirmation (и Branded
  Content Policy при брендированном). Кнопка активна только после выбора видимости и согласия.
  Именно этот экран показывают в записи для аудита Content Posting API.

## 8. Кнопки «во все»

На шаге «Публикация» две кнопки над карточками платформ. **«Опубликовать во все»**: YouTube по
`YOUTUBE_PRIVACY`, Instagram сразу, TikTok при `TIKTOK_DIRECT_POST=1` открывает форму — TikTok требует,
чтобы видимость выбрал сам автор, без формы Direct Post не проходит аудит. **«Черновики во все —
проверить сначала»**: YouTube приватным черновиком (виден только в Studio), TikTok в черновики
приложения («Уведомления → Загрузки», подпись и обложку ставит автор), Instagram пропускается —
черновиков у его API нет. Неподключённые платформы пропускаются с пометкой. Черновики TikTok требуют
права `video.upload`, поэтому при подключении запрашиваются все три права; в Production-приложении
этот scope нужно добавить рядом с `video.publish`.
