# Threads — автономный русскоязычный крипто-аккаунт (раздел `/threads` сайта Гудини)

## Простой интерфейс (сентябрь 2026)

- **Посты**: тема → асинхронное написание → редактор → публикация или расписание. Новости подбираются из настроенных RSS; пост по свободной теме объясняет механику и не придумывает свежие события.
- **Ответы мне**: исходный комментарий, контекст своего поста, ответ и причина отправки/пропуска.
- **Чужие посты**: автоматические содержательные комментарии к обсуждениям крипты.
- **Настройки**: отдельные переключатели для трёх сценариев, стиль и источники. Диагностика вынесена из основного меню.

Автоответ проходит дополнительную проверку релевантности, полезности и обоснованности. Общая блокировка PostgreSQL сериализует отправки из разных очередей. Публичные ответы: до 2/час и 6/сутки, пауза 30 минут, один автор в сутки. Свои: до 6/час и 30/сутки, пауза 5 минут, до двух ответов человеку в ветке за сутки. Похожие тексты и старые обсуждения пропускаются. Одобренные ответы после паузы подхватываются следующим циклом; неоднозначные ошибки отправки автоматически не повторяются.

Профиль текущего владельца можно применить в контейнере командой `node scripts/configure-crypto.mjs`: она включает реальные автоответы, оставляет посты на одобрение и добавляет CoinDesk/Ethereum Blog. Требуются настроенный LLM и отдельный токен Threads; скрипт не получает и не выдаёт разрешения Meta. Секреты остаются в игнорируемом `threads/.env`.

Проверено: `npm run typecheck`, 57 unit-тестов, 4 интеграционных сценария с реальными тестовыми Postgres/Redis и подставным Threads API. В тестах не публикуются реальные комментарии. На работающем сайте проверены реальное написание поста через OpenRouter и отображение на ширине 390 px.

Сервер следит за зарубежными крипто-блогерами и СМИ, понимает инфоповод, проверяет факты, пишет
самостоятельный русский пост (и русскую версию картинки), публикует или отдаёт на одобрение,
отвечает на комментарии, находит релевантные чужие посты и собирает статистику.

Принцип: **SOURCE → FACTS → NEW POST**, а не перевод. Никаких моков под видом готового: там, где
у токена нет разрешения Meta, интерфейс показывает `API permission required`.

```
threads/
  src/            config · db · queue · threads (Graph API) · llm · services · api · workers
  web/            React-дашборд (Vite), отдаётся Fastify под /threads
  migrations/     SQL-миграции (применяются при старте app и worker)
  tests/unit      критические пути без внешних сервисов
  tests/integration/e2e.test.ts   сквозной тест против реальных Postgres/Redis
  docs/           аудит autoTHREADS, целевая архитектура, план миграции
```

## Запуск

Сервис — часть `docker-compose.yml` в корне репозитория (сервисы `threads-app`, `threads-worker`,
`threads-postgres`, `threads-redis`). Ключи — в `threads/.env` (см. `threads/.env.example`).

```bash
cp threads/.env.example threads/.env        # заполнить THREADS_ACCESS_TOKEN и ключ LLM
docker compose up -d --build threads-app threads-worker
```

Адреса: дома `http://192.168.1.68:3000/threads/` (сайт проксирует в контейнер) или напрямую
`http://192.168.1.68:8500/…` для Clipy и `:8600/threads/` для этого сервиса; снаружи
`https://gudinijr.duckdns.org/threads/`. Вход общий с сайтом (`SITE_PASSWORD`, cookie `gudini_auth`).

Локально без Docker:

```bash
cd threads && npm ci
docker run -d --name threads-test-pg -e POSTGRES_USER=threads -e POSTGRES_PASSWORD=threads -e POSTGRES_DB=threads -p 5433:5432 postgres:17-alpine
docker run -d --name threads-test-redis -p 6380:6379 redis:7-alpine
export $(grep -v '^#' .env.test | xargs)      # DATABASE_URL/REDIS_URL на порты 5433/6380
npm run dev          # API + дашборд (после npm run build:web) на :8600
npm run dev:worker   # очереди
```

## Разрешения Threads API

Токен (Meta for Developers → приложение → Threads API → User Token Generator) должен включать:

| Scope | Для чего |
| --- | --- |
| `threads_basic` | профиль, свои посты |
| `threads_content_publish` | публикация постов и ответов |
| `threads_read_replies`, `threads_manage_replies` | комментарии и цепочки |
| `threads_manage_mentions` | @упоминания (без Advanced Access — только тестеры приложения) |
| `threads_keyword_search` | поиск и fallback-чтение профилей через `author_username` (2 200 запросов/сутки) |
| `threads_profile_discovery` | `profile_posts` — публичные посты чужих профилей (100+ подписчиков, 1 000 запросов/сутки) |
| `threads_manage_insights` | метрики публикаций для аналитики |

Токен живёт 60 дней; сервис обновляет его сам (`refresh_access_token`) и пишет `TOKEN_REFRESHED`.

## Режимы и предохранители

- `OFF` — ничего не делает. `DRAFT` — собирает источники и делает черновики. `REVIEW` — черновики и
  ответы ждут кнопок Approve/Send. `AUTO` — уверенный контент уходит сам, рискованный — на проверку
  (`risk < 30`, `confidence > 85`, `score > 75`, пороги в Settings).
- Feature flags по умолчанию `false`: `AUTO_POST_ENABLED`, `AUTO_OWN_REPLIES`, `AUTO_PUBLIC_REPLIES`,
  `IMAGE_TRANSLATION_ENABLED`. `DRY_RUN=true` — Threads только читается, отправки пишутся в лог.
- **STOP AUTOPILOT** в шапке дашборда: мгновенно запрещает публикации, ответы и engagement; идущая
  задача перечитывает флаг перед отправкой.
- Hard caps: посты/сутки, свои и публичные ответы в час и в сутки, минимальный интервал между
  постами, предпочтительные часы (breaking P0 обходит окно, но не лимит).
- Rate limit Meta уважается (backoff), никаких прокси, антидетекта и обхода ограничений.

## Поток

1. **Sources** — профили Threads (`profile_posts` → fallback `keyword_search?author_username`),
   поиск по ключевым словам, RSS. Каждый пост хранится один раз; повторы (hash + shingle-сходство)
   помечаются `DUPLICATE`.
2. **Analyzer** (structured output, zod) — тема, категория, факты со статусом FACT/OPINION/RUMOR/
   PREDICTION, `eventKey`, оценки, `worthPosting`, попытка prompt-инъекции. Чужой текст всегда
   внутри `<untrusted_source_content>`.
3. **Кластеризация** — один `eventKey`/сильное пересечение сущностей → один кандидат с несколькими
   источниками. **Скоринг** — relevance 30 · freshness 20 · source 15 · novelty 15 · value 20 −
   risk penalty; ниже порога — `REJECTED` с причиной.
4. **Fact checker** — цены/капитализация/объём/24h% через `marketDataProvider` (CoinGecko);
   остальное — `UNVERIFIED` (в тексте только с атрибуцией) или `NOT_CHECKABLE`. Число, которое
   противоречит рынку, в текст не попадает.
5. **Writer** — 2 варианта (NEWS/SHORT/OPINION/EXPLAINER/HOT_TAKE) → детерминированная валидация
   (нет чисел вне фактов, оговорки для слухов, без «покупаем/100x», ≤500 символов) → лучший вариант
   → `DRAFT` или `NEEDS_REVIEW` с причинами. Примеры голоса (Voice) подбираются по теме.
6. **Images** — загрузка (SSRF-guard) → OCR vision-моделью (bbox 0–1000) → классификация (тикеры,
   URL, бренды, водяные знаки, @handle не трогаются) → перевод → инпейнт по границам бокса →
   рендер кириллицы контурами глифов (DejaVu) → QA повторным OCR (кириллица есть, английский
   ушёл, числа на месте). Провал QA → `NEEDS_REVIEW`, максимум `imageRetries` повторов.
7. **Publisher** — gate по режиму/риску → слот по расписанию → перепроверка динамических чисел
   перед отправкой (устарели → regenerate) → идемпотентная публикация (`publication_attempts`:
   после таймаута повтор ищет уже созданный пост, а не создаёт второй) → `publications`.
8. **Replies** — inbox `/{user}/replies` + mentions → память разговора (`conversation_messages`) →
   решение SKIP/REPLY/REPLY_AND_QUESTION/NEEDS_REVIEW → короткий ответ без шаблонов → отправка
   (AUTO) или Send в дашборде. **Discovery** — keyword search → скоринг ценности → ответ по существу.
9. **Analytics** — снимки insights, engagement по категории/формату/часу/источнику/длине/хуку,
   расход ИИ (каждый вызов в `llm_calls`), рекомендации только как proposal.

## Дашборд

Overview · Sources · Candidates · Drafts (оригинал слева, наш пост справа, факты, картинка
до/после, Approve/Edit/Regenerate/Schedule/Publish now/Reject, Like/Dislike) · Queue · Published ·
Replies (пост, комментарий, цепочка, предложенный ответ, причина, уверенность; Send/Skip/
Regenerate) · Discovery (watch keywords) · Images · Analytics · Voice · Prompts (версии, активация) ·
Settings · Logs (каждое решение с объяснением).

## Проверки

```bash
npm run typecheck
npm test                 # 52 юнит-теста: дедуп, кластеризация, валидация чисел, gate, идемпотентность, SSRF, картинки, ответы
npm run test:integration # сквозной сценарий против Postgres/Redis из .env.test с fake Threads/LLM
npm run build
```

## Эксплуатация

- Health: `/threads/health`, `/threads/health/db`, `/threads/health/redis`, `/threads/health/threads`, `/threads/health/llm`.
- Логи — JSON (pino) с `requestId`/`jobId`; аудит — таблица `audit_logs` и экран Logs.
- Бэкап: `node scripts/backup.mjs` (pg_dump в контейнере → `data/backups`, хранится 14 копий),
  восстановление `node scripts/backup.mjs --restore <file>`.
- Секреты только в env: не в БД, не в логах, не в ответах API, не в промптах.

## Заимствования

Клиент Threads API, разбиение тредов, RSS-парсер и адаптеры LLM адаптированы из
`eisenjimmy/autoTHREADS` (MIT); типизированные ошибки Meta, опрос контейнера и refresh токена — из
`thenavidm/threads-mcp-cli` (MIT). См. `THIRD_PARTY_NOTICES.md`.
