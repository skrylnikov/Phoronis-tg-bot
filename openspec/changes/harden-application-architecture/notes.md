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
