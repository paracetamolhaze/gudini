# Регистрация приложений для публикации

Все три «приложения разработчика» регистрируются с **любого вашего аккаунта** — это просто контейнер с ключами.
Публикует тот, кто нажал «Подключить …» в Настройках сайта и авторизовался в своём аккаунте.

После каждого блока: полученные ключи вписать в **Настройки** на сайте (или в `.env`) → Сохранить → «Подключить …» с публикующего аккаунта.

---

## ▶️ YouTube Shorts (Google Cloud)

1. Зайдите на https://console.cloud.google.com (любой Google-аккаунт).
2. Вверху «Select a project» → **New Project** → имя, например `Gudini` → Create.
3. Меню ☰ → **APIs & Services → Library** → найдите **YouTube Data API v3** → **Enable**.
4. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User Type: **External** → Create;
   - App name `Gudini`, ваш email в Support email и Developer contact → Save;
   - Audience оставить **Testing**.
5. Там же **Audience → Test users → Add users** — добавьте email каждого Google-аккаунта, с которого будут заливать видео (до 100).
6. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**;
   - Authorized redirect URIs → **Add URI**: `http://localhost:3000/api/auth/youtube/callback`;
   - Create.
7. Скопируйте **Client ID** и **Client Secret** → Настройки сайта → «Подключить YouTube» с аккаунта стримера.

⚠️ Пока проект не прошёл аудит YouTube API, все залитые через API видео принудительно становятся **приватными**. Публичная заливка — после подачи на аудит: https://support.google.com/youtube/contact/yt_api_form (из аккаунта, где создан проект).

---

## 🎵 TikTok

1. Зайдите на https://developers.tiktok.com (любой TikTok-аккаунт) → **Manage apps → Connect an app**.
2. Заполните карточку: название `Gudini`, иконка, описание, категория.
3. В разделе **Add products** подключите:
   - **Login Kit** — авторизация;
   - **Content Posting API** — заливка видео (режим Direct Post).
4. В Login Kit укажите **Redirect URI**: `http://localhost:3000/api/auth/tiktok/callback`.
   - TikTok часто требует **https** и не принимает localhost. Тогда поднимите туннель (`ngrok http 3000`) и укажите `https://<ваш-ид>.ngrok-free.app/api/auth/tiktok/callback` — и заходите на сайт через этот же адрес.
5. Запросите scopes: `user.info.basic`, `video.publish`.
6. Пока приложение не отправлено на ревью, оно в **Sandbox**: в настройках приложения добавьте TikTok-аккаунты стримеров как **target users** — только они смогут авторизоваться.
7. Скопируйте **Client key** и **Client secret** → Настройки сайта → «Подключить TikTok».

⚠️ До прохождения аудита Content Posting API публиковать можно только **приватно** (сайт это делает автоматически: если TikTok отклонил публичный пост, ролик уйдёт как SELF_ONLY). После аудита — публично.

---

## 📸 Instagram Reels (Meta)

Подготовка публикующего аккаунта (обязательно, API иначе не работает):
1. В приложении Instagram: Настройки → Тип аккаунта → **Переключиться на профессиональный** (Business или Creator).
2. Привяжите Instagram к **странице Facebook** (Настройки → Центр аккаунтов / «Связанная страница». Если страницы нет — создайте на facebook.com/pages/create).

Регистрация приложения:
3. Зайдите на https://developers.facebook.com (любой FB-аккаунт) → **Get Started** → станьте разработчиком.
4. **My Apps → Create App** → тип **Business** (use case «Other/Business») → имя `Gudini` → Create.
5. Добавьте продукт **Facebook Login** (for Business) → Settings:
   - **Valid OAuth Redirect URIs**: `http://localhost:3000/api/auth/instagram/callback` (localhost в режиме разработки разрешён).
6. **App settings → Basic** — скопируйте **App ID** и **App Secret** → Настройки сайта.
7. **App Roles → Roles → Add People** — добавьте FB-аккаунты стримеров как **Tester** (или Developer). Они должны принять приглашение: developers.facebook.com/requests.
8. На сайте: «Подключить Instagram» с аккаунта стримера — сайт сам найдёт привязанный Instagram Business аккаунт.

⚠️ Реальная публикация Reels заработает только когда у сервера есть **публичный URL** (Instagram скачивает видео по ссылке): после деплоя укажите его в Настройках («Публичный URL сервера»). Локально без туннеля кнопка работает в демо-режиме.
⚠️ Чтобы подключались посторонние (не добавленные в роли), нужны App Review на `instagram_content_publish` и верификация бизнеса — для своих аккаунтов не требуется.
