## 1. Payment notification delivery

- [x] 1.1 Добавить nullable external delivery id для `BackgroundJob`, создать additive Prisma migration и сгенерировать client; проверить migration на пустой и существующей test database
- [x] 1.2 На успешной отправке возвращать Telegram `message_id` из payment notification handler и сохранять его вместе с completion state; проверить focused background-job/payment test
- [x] 1.3 Покрыть тестами одну durable job на payment/charge, retry временной ошибки и отсутствие отправки после сохранённого delivery id
- [x] 1.4 Добавить structured events с job/payment correlation id для каждой попытки и отдельным признаком retry после неизвестного crash-window результата; проверить поля событий logger-тестом
- [x] 1.5 Покрыть моделируемое crash window тестом: Telegram send успешен, completion не сохранён, следующая попытка остаётся допустимой at-least-once доставкой и использует тот же correlation id

## 2. Polling lifecycle и readiness

- [x] 2.1 Добавить lifecycle-тесты: `/readyz` остаётся 503 до успешного Telegram init/запуска polling loop, startup failure не выставляет ready
- [x] 2.2 Перестроить polling startup вокруг ожидаемой initialization и наблюдаемого long-running promise; проверить happy-path тестом переход transport в ready
- [x] 2.3 При rejection или неожиданном завершении polling loop сбрасывать readiness и запускать существующий fatal shutdown path; проверить тестом 503 и ненулевой exit outcome
- [x] 2.4 Проверить, что webhook lifecycle не изменился, выполнив существующие transport/readiness tests

## 3. Vector-search benchmark gate

- [x] 3.1 Добавить воспроизводимый benchmark с синтетическим seed, фиксированными PostgreSQL/pgvector CPU/RAM параметрами и профилями message/user-fact queries; проверить повторный запуск на чистой базе
- [x] 3.2 Сохранить baseline evidence: production cardinality только агрегатом, целевой размер не меньше `max(2 × cardinality, 100000)`, p50/p95 и `EXPLAIN (ANALYZE, BUFFERS)` для каждого запроса
- [x] 3.3 Если exact p95 не превышает 100 мс, зафиксировать решение не добавлять ANN migration; если превышает — добавить минимальный индекс только для проблемного запроса и проверить повторный p95 ниже budget
- [x] 3.4 При добавлении ANN проверить recall@k не ниже 0,95 относительно exact baseline и корректность chat/user/private filters; не включать индексированный production path при провале проверки

## 4. Общая проверка

- [x] 4.1 Выполнить Prisma migration tests при наличии migration, затем `bun run test`, `bun run typecheck`, `bun run lint` и `git diff --check`; все применимые команды должны завершиться успешно
- [x] 4.2 Убедиться scoped diff-ом, что webhook transport, тарифы и `src/controllers/whats-new.ts` не изменены этим change
