# План реализации

## 1. Основа для фоновых задач и конфигурации

- [x] 1.1 Добавить модель `BackgroundJob` и миграцию PostgreSQL со статусами, типом задачи, уникальным `dedupeKey`, payload, счётчиком попыток, `availableAt`, lease-полями, временными метками и последней ошибкой; проверить `bun run db:generate` и корректность SQL-миграции на чистой базе.
- [x] 1.2 Реализовать репозиторий фоновых задач: постановка с дедупликацией, claim, продление lease, успешное завершение, retry с backoff и terminal failure; проверить операции интеграционными тестами на PostgreSQL, включая конкурирующий claim.
- [x] 1.3 Добавить валидацию `DATABASE_URL` и настройки таймингов/лимитов queue и job worker; проверить ошибки конфигурации тестами и запуском typecheck.

## 2. Явный жизненный цикл приложения

- [x] 2.1 Убрать побочный `prisma.$connect()` при импорте и собрать явный startup/shutdown lifecycle для БД, embeddings, транспорта, очереди и job worker; проверить, что импорт модулей не открывает соединения и lifecycle-тесты проходят.
- [x] 2.2 Ввести состояние готовности runtime: `/healthz` остаётся liveness-проверкой, `/readyz` возвращает 503 до готовности обязательных компонентов и после начала shutdown; проверить сценарии недоступной БД, embeddings, не запущенного транспорта и graceful shutdown.
- [x] 2.3 Сделать остановку транспорта и workers управляемой: прекращать приём новых обновлений, дожидаться ограниченного drain, возвращать незавершённые leases/jobs на повторную обработку и затем отключать Prisma; проверить SIGTERM-тестом отсутствие новых claim после остановки и повторную обработку возвращённых задач.

## 3. Надёжная обработка Telegram updates

- [x] 3.1 Ввести явный контракт результата обработки update и исправить верхнеуровневые catch в message, voice, guest и AI flows так, чтобы временные ошибки доходили до queue retry, а terminal/fallback-ветки завершались только после успешной отправки и сохранения результата; проверить тестами retryable error, terminal error и успешный fallback.
- [x] 3.2 Добавить heartbeat для lease update с проверкой владельца, общий `AbortSignal` для внешних AI/embedding/download/voice операций и остановку работы при потере lease или shutdown; проверить fake-clock тестами продление lease, отмену долгого вызова и отказ stale worker завершить чужую задачу.
- [x] 3.3 Изменить SQL claim так, чтобы pending/processing update старше текущего блокировал тот же `partitionKey` независимо от lane, сохранив параллелизм разных partition; проверить тестами порядок urgent/normal в одном чате и параллельную обработку разных чатов.
- [x] 3.4 Проверить идемпотентность повторной доставки update для сохранения пользователя, сообщения, embedding и отправки ответа; добавить backend-дедупликацию там, где она отсутствует, и метрики для внешнего crash window; проверить duplicate webhook и retry после частичного успеха интеграционными тестами.

## 4. Долговечные фоновые операции и платежи

- [x] 4.1 Перенести обязательное buyer-уведомление об успешной оплате в `BackgroundJob`, создаваемый в транзакции активации, с ключом `payment-order:<id>:buyer`; проверить повторный webhook, временную ошибку Telegram и отсутствие двойного backend-уведомления тестами.
- [x] 4.2 Перенести уведомление beneficiary chat и analytics в отдельные jobs с независимыми dedupe keys, чтобы их сбой не откатывал активацию и не блокировал buyer-уведомление; проверить независимое завершение и retry каждой задачи.
- [x] 4.3 Перенести `analyzeUserMessages` из fire-and-forget в durable job с retry, lease и наблюдаемым terminal failure; проверить перезапуск worker и правило квоты: ошибка до успешного результата не оставляет пользователя с безвозвратно списанной квотой.

## 5. Границы модулей и embeddings

- [x] 5.1 Оставить SQL и Prisma-доступ к embeddings только в `src/repositories/embedding-repository.ts`, а `src/ai/embedding` ограничить TEI-клиентом, orchestration и backfill; проверить typecheck, существующие embedding-тесты и отсутствие прямого Prisma-импорта в AI embedding-модулях.
- [x] 5.2 Вынести только затронутые queue/job/payment orchestration flows в application-level use cases, оставив `domain` свободным от repositories, Prisma и AI integrations; проверить import-scan для новых модулей и отсутствие циклических зависимостей.
- [x] 5.3 Провести аудит callers и удалить только подтверждённые dead exports/дублирующие persistence helpers, обновив README, AGENTS и OpenSpec-документацию под фактический AI stack и runtime flow; проверить поиском устаревших утверждений и отсутствие неиспользуемых production exports.

## 6. Контракты квот и наблюдаемость

- [x] 6.1 Зафиксировать в основной quota spec и кодовых комментариях контракт: personal quota принадлежит пользователю, group quota считается отдельно для каждого участника в конкретном чате; проверить независимое резервирование двух участников и поведение при исчерпании квоты одного участника.
- [x] 6.2 Добавить структурированные события/метрики для queue latency, retry/terminal failure, lease loss, job backlog/failure, readiness transitions и payment notification delivery; проверить наличие correlation/update/job identifiers в логах и пригодность данных для диагностики retry.

## 7. Финальная проверка и rollout

- [x] 7.1 Добавить unit-тесты для outcome mapping, backoff, heartbeat, dedupe и readiness state machine; проверить `bun test` и отсутствие новых flaky timers.
- [x] 7.2 Добавить интеграционные проверки миграций, PostgreSQL claim/order guarantees, payment transaction и durable job recovery; проверить их на чистой схеме и после перезапуска worker.
- [x] 7.3 Выполнить полный локальный quality gate: `bun run db:generate`, `bun run typecheck`, `bun run lint`, тесты и `git diff --check`; зафиксировать результаты в change notes или PR description.
- [x] 7.4 Провести поэтапный rollout с наблюдением readiness, очередей, lease loss, failed jobs и payment notifications; проверить staging/production-next до включения обязательного buyer notification и сохранить процедуру остановки job workers без удаления данных.
