## Context

Payment activation уже отделена от background delivery, runtime имеет readiness state, а vector retrieval работает exact pgvector queries. Остаточные риски находятся на внешних границах: Telegram не предоставляет идемпотентный ключ для `sendMessage`, polling promise обрабатывается после преждевременного ready, а необходимость ANN-индекса не измерена.

## Goals / Non-Goals

**Goals:**

- честно гарантировать backend-дедупликацию и at-least-once Telegram delivery;
- сохранять внешний `message_id` и correlation evidence;
- не объявлять polling transport готовым до успешной инициализации;
- принять решение об ANN на основании воспроизводимого benchmark.

**Non-Goals:**

- обещать внешнюю exactly-once доставку, которой нет в Bot API;
- менять webhook transport или платёжную активацию;
- заранее добавлять HNSW/IVFFlat без превышения budget;
- менять embedding model или алгоритм product relevance.

## Decisions

### Decision: Две разные гарантии доставки документируются отдельно

Уникальность payment/notification job обеспечивается в базе существующим transactional/idempotency key. Вызов Telegram остаётся at-least-once. После успешного `sendMessage` handler возвращает `message_id`, а runner сохраняет его вместе с completion state; между этими действиями остаётся неустранимое crash window. Job id и payment/charge id присутствуют в structured events каждой попытки.

Альтернатива «exactly-once sendMessage» отклонена: Telegram Bot API не принимает клиентский idempotency key и не даёт атомарной транзакции с нашей БД.

### Decision: Delivery metadata добавляется минимально

В `BackgroundJob` добавляется nullable поле внешнего delivery id, достаточное для Telegram `message_id`. Handler может вернуть это значение, а runner сохраняет его при завершении. Новая таблица delivery ledger не вводится; существующие jobs остаются валидными с `null`.

### Decision: Polling readiness опирается на init и контролируемый lifecycle loop

Polling startup сначала дожидается `bot.init()`/эквивалентной Telegram initialization, затем запускает long-polling promise и только после успешного синхронного запуска отмечает transport ready. Поскольку нормальный `bot.start()` живёт до остановки, его не ожидают как startup promise; его rejection/неожиданное завершение сбрасывает readiness и вызывает общий fatal shutdown path.

### Decision: Exact search остаётся default до измеренного нарушения budget

Добавляется отдельный воспроизводимый benchmark и сохраняется baseline. Если p95 укладывается в 100 мс, миграции индекса нет. Если нет, выбирается один минимальный индекс для конкретного подтверждённого запроса; после него обязательны latency, filter-correctness и recall@k проверки.

Reference environment — локальный PostgreSQL/pgvector в контейнере с зафиксированными CPU/RAM и синтетическими embeddings. Из production используется только агрегированная cardinality без пользовательского содержимого; benchmark seed и параметры ресурсов хранятся в репозитории.

## Risks / Trade-offs

- [Crash window всё ещё допускает дубль Telegram-сообщения] → гарантировать backend uniqueness, сохранять `message_id` и коррелировать повтор; stronger guarantee невозможна без поддержки Telegram.
- [Nullable delivery id требует migration] → additive migration безопасна для существующих job rows и допускает rollback приложения.
- [Успешный `bot.init()` не доказывает бесконечную жизнь polling loop] → отдельный watcher немедленно сбрасывает ready при завершении promise.
- [Benchmark зависит от окружения] → результат включает версию PostgreSQL/pgvector, параметры, cardinality и план; решение принимается только на reference environment.
- [ANN может ускорить запрос ценой recall] → production path требует recall@k не ниже 0,95 и корректности privacy/chat filters.

## Migration Plan

1. Добавить nullable external delivery id и сгенерировать Prisma client.
2. Обновить handler/runner и тесты payment retry/crash-window observability.
3. Исправить polling lifecycle и readiness-тесты.
4. Запустить exact-search benchmark и сохранить evidence.
5. Добавлять ANN migration только при превышении budget; иначе завершить change без неё.
6. При откате старое приложение игнорирует nullable поле, exact queries остаются рабочими.
