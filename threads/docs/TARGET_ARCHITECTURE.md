# Целевая архитектура: автономный крипто-аккаунт Threads (RU)

Проект живёт в `threads/` репозитория Гудини как обособленный сервис (по образцу `clipy/`):
свой `package.json`, свой Docker-образ, свои Postgres и Redis. Сайт Гудини проксирует `/threads*`
в контейнер (rewrites в `next.config.ts` и `handle /threads*` в Caddy), вход общий с сайтом
(cookie `gudini_auth`, `SITE_PASSWORD`). Ссылка «Threads» — в шапке сайта рядом с Clipy.

## Процессы

```
gudini-threads-app      Fastify: REST API + web dashboard (статическая сборка Vite под /threads)
                        планировщик периодических задач (BullMQ repeatable jobs)
gudini-threads-worker   BullMQ-воркеры: source, analysis, content, media, publisher, replies,
                        engagement, analytics (один процесс, несколько очередей)
gudini-threads-postgres postgres:17-alpine, том threads-pg-data
gudini-threads-redis    redis:7-alpine, том threads-redis-data
```

Оба Node-процесса собираются из одного образа (`threads/Dockerfile`), различаются командой запуска.
Kill switch, режим (OFF/DRAFT/REVIEW/AUTO) и лимиты хранятся в таблице `settings` и читаются
воркером перед каждым побочным эффектом, а не один раз при старте.

## Поток данных

```
SOURCE INGESTION  threadsProfileSource (profile_posts | keyword_search?author_username)
                  threadsSearchSource (keyword_search по watch keywords)
                  rssSource (CoinDesk, The Block, … любые RSS/Atom)
        ↓ normalize (SourcePost) → content_hash / semantic_hash → source_posts (unique platform+post id)
DEDUP             exact hash → shingle-similarity против 72 ч source_posts, publications, drafts
                  → event cluster (candidate.cluster_id, все источники внутри события)
ANALYZE           LLM analysisModel, structured output SourceAnalysis (zod) → content_candidates
SCORE             relevance 30 · freshness 20 · source priority 15 · novelty 15 · value 20 − riskPenalty
                  ниже minimumContentScore → REJECTED с причиной в audit_logs
FACTS             извлечение claims (из анализа) → fact checker: числа/тикеры через marketDataProvider,
                  даты/суммы — статус VERIFIED | UNVERIFIED (attribution) | CONTRADICTED
WRITE             writerModel: 2 варианта (NEWS/EXPLAINER/SHORT/…) → planner выбирает 1 →
                  валидация: все обязательные числа сохранены, нет запрещённых формулировок,
                  uncertainty сохранена → drafts (DRAFT | NEEDS_REVIEW)
IMAGES            media_assets: download (SSRF guard) → OCR (visionModel, bbox) → классификация
                  блоков (не переводить тикеры/URL/логотипы) → translationModel → inpaint → рендер
                  кириллицы (sharp + SVG, подбор кегля) → QA повторным OCR → final | NEEDS_REVIEW
PUBLISH           режим + risk gate (AUTO только при risk<30, confidence>85, score>75) →
                  очередь по времени (min interval, max/day, preferred hours, приоритет P0..P3) →
                  freshness recheck динамических чисел → idempotent publisher (publication_attempts,
                  проверка «уже опубликовано» по idempotency key перед повтором) → publications
REPLIES           own posts → conversation → reply decision (structured) → reply writer с цепочкой
                  разговора → interactions (OWN_POST_REPLY / MENTION / NESTED_REPLY)
ENGAGEMENT        keyword search → scoring (relevance, freshness, value, spam risk) → лимиты →
                  reply → interactions (PUBLIC_POST_REPLY)
ANALYTICS         insights snapshots по публикациям → performance по topic/hook/length/source/hour,
                  cost tracking по каждому LLM-вызову, рекомендации (только proposal → review → activate)
```

## Слои кода (`threads/src`)

```
config/         env.ts (zod-валидация переменных), settings.ts (runtime-настройки в БД + дефолты)
db/             pool.ts, migrate.ts (SQL-миграции по номерам), repos/*.ts (тонкие запросы)
queue/          connection.ts, queues.ts (имена очередей и приоритеты), scheduler.ts (repeatable jobs)
threads/        client.ts (Graph API: таймаут, ретраи 5xx/квоты, типизированные ошибки, refresh токена),
                publisher.ts (контейнер → status poll → publish, идемпотентность), types.ts
llm/            provider.ts (интерфейс), openaiCompatible.ts (OpenRouter/OpenAI/local), anthropic.ts,
                gemini.ts, structured.ts (zod → JSON schema, парсинг и валидация), costs.ts (цены + ledger)
services/
  sources/      threadsProfileSource.ts, threadsSearchSource.ts, rssSource.ts, sourceManager.ts, normalize.ts
  dedup/        hash.ts, similarity.ts, cluster.ts
  analysis/     schemas.ts (SourceAnalysis), analyzer.ts, scoring.ts
  facts/        factChecker.ts, marketData/provider.ts, marketData/coingecko.ts
  writer/       prompts/, russianWriter.ts, styleRetrieval.ts, validate.ts (числа, запрещённые фразы)
  images/       download.ts, ocr.ts, classify.ts, translate.ts, inpaint.ts, render.ts, qa.ts, pipeline.ts
  publishing/   gate.ts (режим + риск), schedule.ts (окна, интервалы), freshness.ts
  replies/      inbox.ts, decision.ts, writer.ts, conversation.ts
  engagement/   discovery.ts, scoring.ts
  analytics/    insights.ts, performance.ts, recommendations.ts
  audit.ts, limits.ts, killSwitch.ts, mode.ts, promptVersions.ts
api/            server.ts (Fastify), auth.ts (cookie gudini_auth), routes/*.ts, health.ts
workers/        index.ts (регистрация воркеров), handlers/*.ts (чистые функции job → deps)
web/            React + Vite dashboard (Overview, Sources, Candidates, Drafts, Queue, Published,
                Replies, Discovery, Images, Analytics, Voice, Prompts, Settings, Logs)
tests/          критические пути (см. MIGRATION_PLAN)
```

Правила слоёв: `threads/` не знает о промптах; `llm/` не знает о Threads; `images/` не знает о writer;
React-компоненты только рендерят данные API.

## База данных (PostgreSQL)

Таблицы из ТЗ (accounts, sources, source_posts, content_candidates, drafts, media_assets, publications,
interactions, style_examples, prompt_versions, jobs, audit_logs) плюс:

- `settings` — key/value JSON runtime-настроек (режим, пороги, лимиты, watch keywords, модели).
- `event_clusters` — событие с массивом источников; `content_candidates.cluster_id`.
- `publication_attempts` — каждая попытка публикации с `idempotency_key`, `container_id`,
  `threads_post_id`, статусом; publisher проверяет её перед повтором.
- `llm_calls` — provider, model, tokens, cost, operation, candidate_id/draft_id/interaction_id.
- `insight_snapshots` — метрики публикаций во времени.
- `conversation_messages` — цепочка сообщений под нашими постами (для памяти разговора).
- `draft_feedback` — LIKE/DISLIKE по черновикам.
- `recommendations` — предложения аналитики (proposal → review → activated/rejected).

Секреты (токен Threads, ключи LLM) только в env; в БД и логах их нет; API их не отдаёт.

## Модели LLM

`analysisModel`, `writerModel`, `replyModel`, `visionModel`, `translationModel`, `embeddingModel` —
каждая задаётся как `provider:model` (например `openrouter:anthropic/claude-sonnet-5`,
`anthropic:claude-sonnet-5`, `gemini:gemini-3.5-flash`, `openai:gpt-5-mini`). Один провайдер
может обслуживать все задачи. Structured output: JSON-схема из zod, парсинг + валидация, при
несоответствии — ошибка задачи (NEEDS_REVIEW/FAILED), без regex-догадок.

## Безопасность и ограничители

- Kill switch: `settings.autopilot_stopped=true` → worker перед каждым publish/reply читает флаг.
- Feature flags по умолчанию `false`: `AUTO_POST_ENABLED`, `AUTO_OWN_REPLIES`, `AUTO_PUBLIC_REPLIES`,
  `IMAGE_TRANSLATION_ENABLED`; `DRY_RUN=true` — записи в Threads только в лог.
- Hard caps: посты/день, ответы/час/день (свои и публичные) — таблица `interactions`/`publications` как счётчик.
- Уважение rate limit Meta: `RateLimitError` → backoff, без прокси/обхода.
- Prompt injection: весь чужой текст только внутри блока `<untrusted_source_content>` в user-сообщении,
  system prompt явно велит считать его данными.
- SSRF: загрузка изображений только `https`, публичные IP (DNS резолв → проверка диапазонов),
  ≤ 5 редиректов на публичные адреса, ≤ 15 МБ, только `image/*`, таймаут 20 с.
