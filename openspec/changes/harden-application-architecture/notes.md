# Локальная проверка

Проверено 23 августа 2026 года:

- `bun run db:generate` — успешно.
- `bun run typecheck` — успешно.
- `bun run lint` — успешно; Biome выводит только информационное предупреждение о schema version 2.5.10 при CLI 2.5.5.
- `bun run test` — 39 test files, 155 tests, без ошибок.
- `git diff --check` — успешно.
- `openspec validate harden-application-architecture --type change --strict` — успешно.
- Payment и user-analysis orchestration вынесены в `src/application`; подтверждённый неиспользуемый user-analysis façade удалён.

До запуска тестового контейнера локальный PostgreSQL на `127.0.0.1:5433` был недоступен; rollout в staging/production по-прежнему не выполнялся.

После запуска `phoronis_postgres` из `docker-compose.yml` дополнительно проверено:

- `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/phoronis?schema=public bun run db:deploy` — все 20 миграций применены на чистой базе.
- `DATABASE_URL=... bun run test:integration` — 19 тестов, без ошибок: dedupe/concurrent claim, lease recovery, worker restart, payment transaction, cross-lane ordering, parallel partitions, queue stop с возвратом lease и idempotent persistence/embedding.

## Rollout production-next

Проверено 23 августа 2026 года после commit `94655ef`:

- GitHub Actions run `32650601349` — quality и image успешно; Trivy без HIGH/CRITICAL unfixed findings.
- Flux image automation опубликовал `infra` commit `1b2d570df2487cd83032845604dd88a717fe3ed9` и применил его во всех трёх Kustomization.
- `ghcr.io/skrylnikov/phoronis-tg-bot:master-1787501183-94655ef44f73@sha256:10e19518b5b0e054cf05ed08b835f84a7c7845db76c41afe40dae4d6974d4cc8` раскатан rolling update с новым pod без рестартов.
- Init `wait-for-vector` и `migrate` завершились с кодом 0; production применил миграцию `20260823150000_add_background_jobs`.
- `/healthz` и `/readyz` внутри pod вернули 200; readiness: database, embeddings, transport, updateWorkers и jobWorker — `ready`.
- Webhook smoke: GET `/telegram/webhook` — 405, неавторизованный POST — 401; свежие логи подтверждают `transport.started` и `transport.webhook_unauthorized`.
- Очереди после запуска: Telegram inbox — 0 `PENDING`/`PROCESSING`, durable jobs — 0 по всем статусам; в startup backlog `pending=0`, `processing=0`, `failed=0`. Исторические Telegram updates: 10 `FAILED`, 11509 `COMPLETED`.

Остановка workers выполняется штатным SIGTERM через rolling update/scale-down: runtime переводит состояние в `stopping`, прекращает новые claims, abort-ит активную обработку, освобождает lease и оставляет данные в PostgreSQL; удаление job/update rows для остановки не используется.
