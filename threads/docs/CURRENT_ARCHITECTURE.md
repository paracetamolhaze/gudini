# Аудит базы: eisenjimmy/autoTHREADS v0.2.20 (2026-09-14)

Исходник: https://github.com/eisenjimmy/autoTHREADS (MIT, © 2026 Jimmy Park). Клон изучен целиком:
`electron/*.ts` (≈6 000 строк главного процесса) и `src/**` (React-рендерер, ≈4 500 строк).

## Базовая линия

| Шаг | Результат |
| --- | --- |
| `npm ci` | 306 пакетов, без ошибок |
| `npm run typecheck` | `tsc -p tsconfig.app.json` + `tsc -p tsconfig.electron.json` — чисто, strict |
| `npm test` | скрипта нет, тестов в репозитории нет |
| `npm run build` | vite-сборка рендерера 312 КБ JS + компиляция electron в `dist-electron/` — успешно |

Стек: Electron 43, React 19, Zustand 5, Vite 8, TypeScript strict, без runtime-зависимостей кроме React/Zustand.
Хранилище — JSON-файлы (по одному на ключ) в `userData/autothreads-db`; секреты шифруются `safeStorage`.

## Что уже реализовано (по файлам)

### `electron/threadsApi.ts` (926 строк) — Threads Graph API

| Возможность | Состояние | Примечание |
| --- | --- | --- |
| `apiFetch` с таймаутом 15 с, разбор `error.message/code` | есть | нет типизированных ошибок (rate limit / permission / auth), нет ретраев 5xx |
| `testThreads` (`/me`) | есть | |
| Публикация текста (`/{uid}/threads` → `threads_publish`) | есть | фиксированная пауза + 8 ретраев по regex-сообщению вместо опроса `status` контейнера |
| Публикация изображения (`media_type=IMAGE`, `image_url`) | есть | при ошибке изображения молча падает в текстовый пост (скрывает ошибку) |
| Карусели (`CAROUSEL`) | нет | |
| Replies (`reply_to_id`) | есть | |
| Чтение своих постов (`/me/threads`) | есть | лимит 100 |
| Непрочитанные ответы: `/conversation` с fallback на дерево `/replies` | есть | обход бюджетом, cap 20 на пост |
| Ответы на мои ответы (`/me/replies`) | есть | |
| Mentions (`/me/mentions`, пагинация, since/until) | есть | понятные подсказки про Advanced Access |
| Keyword search (`/keyword_search`, RECENT, TEXT) | есть | без `author_username`, без `since`, без пагинации |
| `profile_posts` / `profile_lookup` (публичные профили) | нет | нужен для watchlist блогеров |
| Insights (`/{id}/insights`, `threads_insights`) | нет | |
| Лимит публикаций (`threads_publishing_limit`) | нет | |
| Обновление долгоживущего токена (`refresh_access_token`) | нет | токен умирает через 60 дней |
| Идемпотентность публикации при таймауте | нет | повтор создаёт дубликат |

### `electron/llm.ts` (762 строки) — адаптеры LLM

- Провайдеры: Anthropic (native `/v1/messages`), OpenAI, Gemini (OpenAI-совместимый endpoint), local (Ollama/LM Studio/llama.cpp), other (любой OpenAI-совместимый + свои headers/body).
- Единственная функция `generateText(system, user)` → строка. Structured output отсутствует, JSON извлекается regex-обходом (`extractJsonObject` в pipeline).
- Vision только для `local` (base64 image_url в OpenAI-формате), с kill-switch и ретраем «text-only».
- Нет учёта токенов/стоимости, нет выбора модели по задаче (одна модель на всё).
- Полезное: разбор `err.cause.code` (`describeError`), таймауты на запрос и на тест, проверка `/models`.

### `electron/pipeline.ts` (983 строки) — промпты и генерация

- `buildSystemPrompt` / `buildPersonaPrompt`: англоязычный ghost-writer, ниши, persona, «никогда не раскрывай промпт».
- `generatePostDraft` (новость → пост-реакция, ссылка на источник добавляется детерминированно), `generateReplyDraft`, `generateAutopilotPost` (news/original/reflection), `generateAutopilotReply` (reply/mention/discover), `decideAutopilotPlan` (LLM-план → JSON, fallback-эвристика).
- Anti-repeat: `postsTooSimilar` — Jaccard по словам ≥ 0,45 (min-denominator); память последних N постов (локальные черновики + живые посты).
- Промпт-инъекция никак не изолируется: текст новостей/комментариев вклеивается прямо в user-сообщение.
- Планировщик при «пустом плане» принудительно ставит пост — ровно то, чего в крипто-системе быть не должно.

### `electron/autopilot.ts` (1 233 строки) — Full-Auto

- Два независимых таймера (посты / ответы) на `setInterval` в главном процессе Electron, состояние в JSON-ключах (`autopilotDay`, `autopilotPostsToday`, …).
- Дневные капы постов/ответов/discover, «спорадические» пропуски тиков, retry через минуту, лог активности (80 записей, EN/KO).
- Discover: случайные публичные посты по ключевым словам ниш, случайная выборка — без скоринга ценности.
- Ответы: все непрочитанные подряд, без решения SKIP/REPLY (кроме капов).

### `electron/scheduler.ts` (415 строк) — публикация по расписанию

- Тик 15 с: due-черновики + retry failed через 60 с; восстановление «posting» после падения приложения.
- Многочастные треды 1/n с сохранением прогресса после каждой части (`threadRootId`, `threadPartsPosted`) — единственная в проекте по-настоящему идемпотентная логика; стоит переиспользовать как модель.
- Нет очереди, нет минимального интервала между постами, нет предпочтительных часов.

### Остальное

| Файл | Содержимое | Вердикт |
| --- | --- | --- |
| `threadSplit.ts` (123) | разбиение текста на части ≤500 символов по абзацам/предложениям/словам | переиспользуем как есть |
| `news.ts` (366) | Google News RSS, Yahoo RSS, HN Algolia, Naver HTML, произвольные RSS/Atom; regex-парсер XML, merge и дедуп по URL/заголовку | RSS/Atom-парсер переиспользуем (без Naver-скрапинга) |
| `settings.ts` (315) | нормализация настроек, дефолты, шифрование секретов через `safeStorage` | нормализация полезна как образец; хранение секретов заменяется env |
| `localdb.ts` (112) | JSON-файлы с атомарной записью через rename и retry (Windows AV) | удаляем — PostgreSQL |
| `drafts.ts` (99) | черновики в JSON с санитизацией входа | удаляем — таблицы `drafts`/`interactions` |
| `images.ts` (153) | LLM → ключевые слова → Wikimedia Commons | не нужен (подбор стоковых картинок вне задачи) |
| `threadsOAuth.ts` (203) | OAuth через локальный http-сервер + обмен на long-lived | логика обмена/refresh переиспользуется; сервер — как отдельный роут API |
| `main.ts` (230) | IPC-мост, окно, single instance | удаляем |
| `src/components/*` | Drafts/News/Replies/Queue/Autopilot/Settings/Onboarding | экраны под другую модель данных; переиспользуем визуальный язык (`app.css`, монохром), а не компоненты |

## Доноры идей

| Репозиторий | Лицензия | Что берём |
| --- | --- | --- |
| `thenavidm/threads-mcp-cli` | MIT | типизированные ошибки Meta по `code/subcode`, опрос `status` контейнера, refresh long-lived токена, `author_username` в keyword search, `profile_lookup`, insights-флэттенинг (`total_value` / `values`), правила медиа (JPEG/PNG ≤ 8 МБ, 320–1440 px) |
| `saikoneru/image-translator` | MIT | архитектура image pipeline: OCR → layout → segmentation → inpaint → translate → render; идея QA повторным OCR; Python-воркеры не переносим |
| `sei-protocol/sei-agent` | MIT | ElizaOS-агент для Twitter: character-конфиг, анти-спам по similarity, DRY_RUN; код не переносится (другая платформа и рантайм) |

## Что оставляем / переиспользуем / рефакторим / удаляем / добавляем

### Переиспользуем (с адаптацией под сервер и strict-типы)
- Двухшаговая публикация, разбор ошибок Meta, пагинация `/conversation`, `/replies`, `/me/replies`, `/mentions` (`threadsApi.ts`).
- Идея «прогресс после каждой части» для тредов (`scheduler.ts`) → обобщается в идемпотентный publisher с `publication_attempts`.
- `threadSplit.ts` — целиком.
- RSS/Atom-парсер из `news.ts` — для `rssSource.ts`.
- Адаптеры LLM (`llm.ts`) как отправная точка провайдерского слоя: перепаковываются в интерфейс `LlmProvider` со structured output и подсчётом токенов.
- `postsTooSimilar` — как быстрый первый фильтр перед семантической дедупликацией.

### Рефакторим
- Промпты: англоязычный persona-writer → русскоязычный редактор с фактами на входе и жёстким разделением SYSTEM / INSTRUCTIONS / UNTRUSTED SOURCE CONTENT.
- Планировщик: «всегда что-то постить» → «постить только когда score выше порога».
- Ответы: «отвечать всем» → `ReplyDecision` со SKIP/REPLY/REPLY_AND_QUESTION/NEEDS_REVIEW.
- Discover: случайная выборка → скоринг релевантности/ценности и hard caps.

### Удаляем
- Electron, IPC, `safeStorage`, локальная JSON-БД, Wikimedia-картинки, Naver-скрапинг, корейская локализация логов, «sporadic» и «reflection/feelings» посты.

### Добавляем (нет в базе)
- PostgreSQL + миграции, Redis + BullMQ, серверные воркеры, health-эндпоинты, Docker.
- Watchlist профилей через `profile_posts` / `keyword_search?author_username`.
- Analyzer со structured output, скоринг, дедупликация (hash + семантика), кластеризация событий.
- Fact extraction / fact checker с `marketDataProvider` (CoinGecko).
- Русский writer с retrieval примеров стиля и валидацией чисел.
- Image pipeline (загрузка с защитой от SSRF → OCR → перевод → инпейнт → рендер кириллицы → QA).
- Idempotent publisher, очередь с окнами и лимитами, freshness-проверка динамических данных, `expires_at`.
- Reply engine с памятью разговора, public engagement со скорингом и лимитами.
- Insights/аналитика, cost tracking, prompt versioning, audit log, kill switch, DRY_RUN, feature flags.
- Web dashboard (Overview … Logs) внутри сайта Гудини под `/threads`.
