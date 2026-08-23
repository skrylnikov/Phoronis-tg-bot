## Context

Текущий процесс уже использует PostgreSQL как durable inbox для Telegram updates, четыре in-process workers и advisory locks для scheduler/backfill. Однако обработчики и AI orchestration скрывают ошибки от inbox, а долгие внешние операции не имеют общего cancellation/lease-контракта.

Существующие `src/ai/embedding/store.ts` и `src/repositories/embedding-repository.ts` частично дублируют persistence SQL. Платёжная активация транзакционна, но последующие Telegram-уведомления не имеют durable delivery state. См. `proposal.md` и delta specs для контрактов.

## Goals / Non-Goals

**Goals:**

- Сделать PostgreSQL inbox единой границей retry и ownership для Telegram updates.
- Не допускать конкурентной обработки конфликтующих updates одной partition.
- Перенести пользовательские и quota-критичные фоновые операции в durable job processing.
- Гарантировать повторяемую доставку подтверждения покупателю после активации платежа.
- Сделать startup/readiness/shutdown наблюдаемыми и безопасными для rolling update.
- Упростить границы модулей и оставить один persistence-модуль для embeddings.

**Non-Goals:**

- Не вводить микросервисы, отдельный broker, новый DI-контейнер или новую внешнюю зависимость.
- Не менять Telegram-команды, модели AI, тексты тарифов и правила распознавания изображений.
- Не переносить Prisma generated client в `node_modules` в рамках этого change: это отдельная совместимость Prisma 7/Bun/Docker.
- Не добавлять vector index без подтвержденного `EXPLAIN` и измеримого performance-регресса.

## Decisions

### 1. Сохранить PostgreSQL inbox и добавить явный outcome

`TelegramUpdate` остается источником истины для webhook delivery. Ошибки верхнего уровня не поглощаются: обработчик либо завершает пользовательский fallback и возвращает успех, либо пробрасывает повторяемую/терминальную ошибку в queue boundary. Queue сохраняет `lastError`, attempts и итоговый status.

Внутренний outcome можно реализовать минимально через обычное пробрасывание ошибок и небольшой набор typed ошибок, а не через универсальный workflow engine. Ошибки «message is not modified», invalid user input и уже выполненный idempotent operation считаются terminal/success согласно конкретному handler.

### 2. Lease heartbeat и общий cancellation signal

После claim worker запускает heartbeat примерно раз в 30 секунд и продлевает lease только для своего `workerId`. Потеря lease или остановка процесса вызывает `AbortController` для поддерживаемых внешних операций. AI, embeddings, Telegram file download и voice processing принимают этот signal.

Перед `markCompleted` worker проверяет, что lease всё ещё принадлежит ему. Если heartbeat не может продлиться, обработка прекращается и update остаётся retryable после истечения lease.

Альтернатива «просто увеличить lease» отклоняется: максимальная длительность AI/voice заранее не ограничена, поэтому это только отодвинет дубликаты.

### 3. Строгая взаимная блокировка внутри partition

SQL claim сохраняет запрет на выбор update, если существует более старый `PENDING` или `PROCESSING` update с тем же `partitionKey`, независимо от lane. Urgent workers сохраняются для приоритета между независимыми partition, но не могут выполнять конфликтующие updates одного чата параллельно.

Это сознательная уступка latency в пользу корректности состояния. Параллельность сохраняется между разными чатами/users.

### 4. Один durable job runner для некратковременных фоновых операций

Добавляется минимальная таблица `BackgroundJob` с типом, уникальным `dedupeKey`, JSON payload, status, attempts, `availableAt`, lease, worker id, timestamps и последней ошибкой. В неё попадают только операции, которые меняют пользовательские данные, расходуют quota или должны пережить restart: user analysis и payment notifications.

Embedding backfill остается отдельным сканирующим worker’ом, потому что его прогресс уже определяется `embeddingVersion` в данных и ему не нужен job на каждое сообщение.

Job runner использует тот же PostgreSQL claim/lease/retry паттерн, но не переиспользует `TelegramUpdate` для несвязанных payload. Дедупликация выполняется уникальным `dedupeKey`.

### 5. Payment activation и notifications разделяются

Транзакция оплаты только активирует подписку и создаёт durable jobs для buyer confirmation, beneficiary chat и analytics. Buyer job обязательна; secondary jobs не меняют состояние оплаты при ошибке.

Повторный payment update делает `ensure` существующих jobs по детерминированным ключам `payment-order:<id>:<kind>`, поэтому `activatedNow=false` не означает, что все уведомления уже доставлены. Worker отмечает job completed только после успешного Telegram API вызова.

Невозможное обещание «Telegram никогда не создаст duplicate при crash между HTTP response и записью completed» не маскируется: backend гарантирует dedupe до успешной записи результата, а crash-window наблюдается и обрабатывается replay/операционным мониторингом.

### 6. Явный application lifecycle и readiness state

Top-level `prisma.$connect()` убирается из import side effect. Runtime создаёт конфигурацию, подключает DB, проверяет embeddings, запускает queue/job workers и transport, после чего выставляет readiness=true. `/healthz` остаётся liveness без внешних зависимостей, `/readyz` проверяет runtime state плюс DB/embeddings.

При shutdown readiness немедленно сбрасывается, transport перестаёт принимать новые updates, workers drain или возвращают leaseable jobs, затем закрываются scheduler, job runner, embedding worker и Prisma.

### 7. Ограниченные модульные границы

Новые и изменяемые flow следуют направлению `controllers/transport → application use-case → repositories/integrations`. `domain` содержит чистые тарифные и quota-правила; AI prompt/tool code остаётся integration/application кодом и не называется чистым domain.

Embedding SQL объединяется в `src/repositories/embedding-repository.ts`; `src/ai/embedding` отвечает за TEI client, orchestration и backfill, но не открывает Prisma напрямую. Неиспользуемые дублирующие exports удаляются после проверки production callers.

Полная миграция всех старых controllers в один большой service запрещена: перенос выполняется по затронутым flow (updates, payment, background jobs), чтобы не создавать новый god object.

### 8. Quota contract сохраняет текущую модель данных

Групповая quota остаётся per-member: `CHAT` usage keyed by user and chat. Миграция данных не нужна. Добавляются contract/integration tests, проверяющие независимость счетчиков участников и возврат reservation при ошибке.

## Risks / Trade-offs

- [Долгий AI-запрос блокирует следующие updates того же чата] → строгий порядок выбран сознательно; ограничить внешние операции signal/timeout и наблюдать queue wait time.
- [Heartbeat продлевает зависший worker] → heartbeat имеет общий deadline, worker aborts при ошибке продления, а lease ограничен максимальным временем операции.
- [Durable jobs увеличивают schema и operational surface] → использовать одну минимальную таблицу только для quota/user/payment-critical задач; embedding backfill не дробить на jobs.
- [Повторная Telegram отправка может попасть в crash-window] → детерминированные job keys, сохранение результата, replay metrics и ручной repair command; не заявлять абсолютную exactly-once доставку внешнего API.
- [Rollback с незавершёнными jobs] → перед rollback остановить новый worker и проверить backlog; jobs сохраняются, а миграция откатывается только после drain или отдельного replay.
- [Миграция persistence может изменить search semantics] → перед удалением store/repository функций сравнить SQL, privacy-фильтры, threshold и embeddingVersion на integration fixtures.

## Migration Plan

1. Добавить backward-compatible `BackgroundJob` migration и новые repository/test helpers; старое поведение Telegram и платежей не меняется.
2. Включить job runner и readiness lifecycle в shadow/disabled режиме, проверить claims, lease renewal, shutdown и metrics.
3. Перевести payment notifications на jobs, затем user analysis; сохранить replay path для уже активированных PaymentOrder.
4. Исправить update error propagation, cross-lane partition claim и heartbeat; после этого включить строгие retry assertions.
5. Объединить embedding persistence и удалить только подтверждённые dead exports; обновить README, AGENTS и OpenSpec references.
6. Перед rollout выполнить unit, PostgreSQL integration, typecheck, lint и `git diff --check`; после rollout проверить ready state, inbox backlog, failed jobs, queue latency, duplicate attempts и payment notification backlog.

Rollback: приложение откатывается только после остановки новых workers и проверки durable backlog. Schema migration не удаляется во время rollback; pending jobs остаются для replay после возврата совместимой версии.
