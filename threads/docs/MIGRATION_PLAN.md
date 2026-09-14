# План миграции autoTHREADS → серверная система

## Принципы
- Не переписывать рабочее без причины: клиент Threads, разбиение тредов, RSS-парсер, идея идемпотентного
  прогресса — переносятся с адаптацией; всё, что завязано на Electron, отбрасывается.
- Каждый этап заканчивается `npm run typecheck && npm test && npm run build` в `threads/` и коммитом.
- Ничего «мокового» не выдаётся за готовое: если функция требует недоступного разрешения Meta,
  UI показывает `API permission required` с названием scope.
- Пока поток WATCHLIST → DRAFT нестабилен, режим AUTO не включается (флаги по умолчанию выключены).

## Этапы

| Фаза | Содержание | Артефакты |
| --- | --- | --- |
| 1. Audit | клон, baseline (install/typecheck/build), документы | `docs/CURRENT_ARCHITECTURE.md`, `TARGET_ARCHITECTURE.md`, этот план, `THIRD_PARTY_NOTICES.md` |
| 2. Core extraction | `threads/` проект: env, Postgres + миграции, Redis + BullMQ, Threads client (из autoTHREADS + threads-mcp-cli), LLM providers со structured output и cost ledger, Fastify + health, Docker, интеграция в сайт (`/threads`, ссылка в шапке) | `src/config`, `src/db`, `src/queue`, `src/threads`, `src/llm`, `src/api`, `Dockerfile`, compose-сервисы |
| 3. Source engine | таблица sources, profile watcher (`profile_posts` → fallback `keyword_search?author_username`), search source, RSS, polling по приоритету, нормализация, exact/semantic dedup, candidates | `src/services/sources`, `src/services/dedup`, worker `source` |
| 4. Crypto intelligence | analyzer (SourceAnalysis), scoring, fact extraction, fact checker + CoinGecko provider, event clustering, expires_at | `src/services/analysis`, `src/services/facts`, worker `analysis` |
| 5. Writer | русский writer (2 варианта → 1), style retrieval, валидация чисел/фраз, prompt versions, drafts, LIKE/DISLIKE | `src/services/writer`, worker `content` |
| 6. Images | download (SSRF), OCR через visionModel, классификация блоков, перевод, инпейнт, рендер, QA, `imageRetries` | `src/services/images`, worker `media` |
| 7. Publishing | режимы, risk gate, очередь/окна/лимиты/приоритеты, freshness recheck, idempotent publisher, expired drafts | `src/services/publishing`, `src/threads/publisher.ts`, worker `publisher` |
| 8. Replies | inbox (conversation/mentions), ReplyDecision, reply writer, память разговора, лимиты | `src/services/replies`, worker `replies` |
| 9. Public engagement | keyword discovery, scoring, лимиты, генерация ответа | `src/services/engagement`, worker `engagement` |
| 10. Dashboard | все экраны, kill switch, режимы, action buttons, activity log с объяснениями | `web/` |
| 11. Analytics | insights snapshots, performance, cost dashboard, source learning, recommendations | `src/services/analytics`, worker `analytics` |
| 12. Hardening | structured logs с requestId/jobId, health checks, backups (pg_dump скрипт), security audit, `.env.example`, README | `scripts/`, `README.md` |

## Тесты критических путей (node:test через tsx)

1. Один и тот же source post дважды → один candidate (`sourcePosts.upsert` + dedup).
2. Два автора, одна новость → один event cluster.
3. LLM изменил число → валидация writer падает → NEEDS_REVIEW.
4. AUTO выключен / kill switch → publisher ничего не публикует.
5. Таймаут Threads после отправки → повтор не создаёт дубликат (`publication_attempts` + проверка `/me/threads`).
6. Спам-комментарий → SKIP; нормальный вопрос → REPLY (детерминированные правила + structured decision).
7. Prompt injection в тексте источника → не попадает в system, помечается как untrusted, writer не выполняет.
8. English image → Russian image: обязательные числа сохранены (QA по OCR-результату).
9. Expired breaking news → не публикуется.
10. E2E: fixture «Bitcoin ETFs recorded $650M net inflows…» → candidate → facts → verification → RU post → draft → approve → fake Threads publisher.

Юнит-тесты не требуют внешних сервисов (LLM/Threads/CoinGecko подменяются интерфейсами).
Интеграционные (`npm run test:integration`) идут против реальных Postgres/Redis из compose.

## Дерево каталогов

```
threads/
  package.json  tsconfig.json  Dockerfile  .env.example  README.md  THIRD_PARTY_NOTICES.md
  docs/                      этот аудит и план
  migrations/                0001_init.sql, …
  src/
    index.ts                 точка входа app (API + scheduler)
    worker.ts                точка входа worker
    config/  db/  queue/  threads/  llm/  services/  api/  workers/  shared/
  web/                       Vite + React dashboard → dist/ отдаётся Fastify под /threads
  tests/
    unit/  integration/  fixtures/
```

## Файлы autoTHREADS, которые переносятся

| Источник | Куда | Как |
| --- | --- | --- |
| `electron/threadsApi.ts` | `src/threads/client.ts`, `src/services/replies/inbox.ts` | разделяется на транспорт (типизированные ошибки, ретраи, refresh) и доменные выборки (conversation, mentions) |
| `electron/threadSplit.ts` | `src/shared/threadSplit.ts` | без изменений |
| `electron/news.ts` (RSS/Atom parser, mergeNews) | `src/services/sources/rssSource.ts` | без Google/Yahoo/Naver-специфики |
| `electron/llm.ts` (адаптеры) | `src/llm/*` | интерфейс `LlmProvider`, structured output, usage |
| `electron/scheduler.ts` (прогресс тредов) | `src/threads/publisher.ts` | обобщено до publication_attempts |
| `electron/pipeline.ts` (`postsTooSimilar`) | `src/services/dedup/similarity.ts` | первый фильтр |
| `electron/threadsOAuth.ts` (обмен/refresh) | `src/threads/tokens.ts` | без локального http-сервера |
| `src/styles/app.css` (визуальный язык) | `web/src/styles.css` | тёмный монохром, свои компоненты |
