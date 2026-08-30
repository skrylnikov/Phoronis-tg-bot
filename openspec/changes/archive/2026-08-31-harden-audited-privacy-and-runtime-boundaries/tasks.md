## 1. Схема данных и безопасные миграции

- [x] 1.1 Добавить модель `UserFactEvidence` с unique constraint на fact/chat/message, связями и индексами, сохранить legacy `UserFact.source*` для совместимости и проверить `bun run db:generate` и `bun run typecheck`.
- [x] 1.2 Создать миграцию evidence с backfill существующих непустых `UserFact.sourceChatId/sourceMessageId` и проверить PostgreSQL integration-тестом, что повтор той же тройки не создаётся.
- [x] 1.3 Заменить self-reply FK `Message` на `ON DELETE SET NULL`, добавить индекс для private retention и проверить integration-тестом удаление просроченного parent при сохранении более нового reply.
- [x] 1.4 Добавить в миграцию удаление только тех `AiThreadContext`, где event связан с `Message.private = true`, и проверить fixture-тестом каскадное удаление их events при сохранении неприватного thread.

## 2. Private mode и области пользовательских данных

- [x] 2.1 Сохранить в обычном private-mode AI path durable thread builder, public retrieval/vector search, recent public history, memory/facts, поиск упомянутых пользователей, `save_memory` и запись assistant event; связать события private-turn с private messages, исключать их из следующего context и запретить их compaction; проверить unit и PostgreSQL integration-тестами text/photo, текущий и последующий turn.
- [x] 2.2 Ограничить автоматическую сборку контекста: глобальные personal memory/facts только для текущего отправителя, shared memory только текущего чата, факты другого пользователя только с current-chat evidence; проверить тестом упоминание пользователя, имеющего данные в другом чате.
- [x] 2.3 Изменить `get_user_info` для другого пользователя на актуальную Telegram membership-проверку и current-chat evidence без personal memory; проверить сценарии member, left и Telegram API failure.
- [x] 2.4 Сделать similarity/embedding/model errors fact analyzer повторяемыми вместо результата «не дубликат» и проверить, что durable analysis job возвращает ANALYSIS quota и остаётся retryable.
- [x] 2.5 Сохранять fact evidence и менять weight/history атомарно только при новом source; проверить retry после частичного успеха и повтор старого source после более нового усиления.
- [x] 2.6 Пробрасывать ошибку проверки reply parent вместо сохранения `replyToMessageId = null` и проверить, что временная DB-ошибка оставляет Telegram update доступным для retry.

## 3. Авторизация и доставка приветствия

- [x] 3.1 Убрать `chatId` и `userId` из input schema `set_greeting`, использовать текущие `ctx.chatId/ctx.from.id`, group check и admin status, добавить trim/1–4096 validation; проверить spoofed admin, cross-chat и oversized greeting тестами.
- [x] 3.2 Удалить несуществующий `greetingEnabled` из new-member query и сохранить membership delay semantics; проверить unit-тесты и реальный Prisma integration-запрос без validation error.

## 4. Безопасная обработка media и длинных ответов

- [x] 4.1 Добавить общий abortable Telegram file downloader с потоковым лимитом и без логирования credential URL; проверить declared и фактическое превышение 20 MiB без создания полного буфера.
- [x] 4.2 Передавать vision-провайдеру байты изображения вместо Telegram URL и проверить spy-тестом AI request, что bot token отсутствует в body, URL и error metadata.
- [x] 4.3 Возвращать VOICE quota и отправлять русскоязычный отказ при превышении media limit; проверить, что ffmpeg и speech API не вызываются.
- [x] 4.4 Удалить opt-in speech data logging, использовать уникальный S3 object key и cleanup в `finally`; проверить delete после success, provider error, timeout и abort, включая отдельный cleanup-failure log.
- [x] 4.5 Реализовать финальную delivery policy: legacy до 4096, forced Rich Message до 32768 и UTF-8 text document выше; проверить private/group/topic ответы на границах 4096/4097/32768/32769 без потери текста.
- [x] 4.6 Установить для специальных transport output budget 4096 tokens и проверить, что Telegram rejection финального payload сверх 4096 символов не помечает AI response успешным и освобождает quota по действующему контракту.

## 5. Bounded context и плановые задачи

- [x] 5.1 Читать durable AI context от последнего подтверждённого boundary вместо include всей relation и проверить, что pre-boundary events не попадают в repository result.
- [x] 5.2 Объединить commit boundary/cache counter и удаление старых events безопасной transaction; проверить successful prune, failed compaction и concurrent tail preservation.
- [x] 5.3 Назначить отдельные advisory lock keys плановым задачам и различать `completed/skipped/failed`; проверить одновременный запуск одинаковых и разных task types.
- [x] 5.4 Сделать scheduler registry идемпотентным, отслеживать active runs и добавить async stop в runtime shutdown до DB disconnect; проверить повторный start и порядок SIGTERM lifecycle.
- [x] 5.5 Перевести fact impact recalculation на set-based SQL либо ограниченные batches и проверить DB-тестом, что путь не загружает все `FactImpact` relation в процесс.
- [x] 5.6 Исправить convergence metaInfo migration с уже существующими фактами и проверить restart/idempotency тестом очистку legacy payload без duplicate facts.

## 6. CI и локальная приёмка

- [x] 6.1 Добавить в quality job изолированный PostgreSQL с pgvector, применить migrations и запускать `bun run test:integration` после unit suite; проверить workflow локальным equivalent либо успешным GitHub Actions run.
- [x] 6.2 Расширить integration suite DB-контрактами из задач 1–5 и проверить, что тесты воспроизводят прежние invalid select, RESTRICT cleanup и duplicate evidence до исправления.
- [x] 6.3 Запустить `bun run lint`, `bun run typecheck`, `bun run test:unit`, `bun run test:integration`, `openspec validate --specs` и strict validation change; все команды MUST завершиться успешно, а worktree MUST содержать только связанные изменения.

## 7. Rollout и секреты

- [x] 7.1 Подготовить migration preflight с count/EXPLAIN для private-context purge и fact evidence backfill, зафиксировать ожидаемые lock/rollback условия и проверить его на production-like snapshot без изменения production.
- [ ] 7.2 После отдельного разрешения на deployment применить миграции и новую версию, проверить readiness, shutdown logs, scheduler outcomes, доступность полного private-mode context pipeline при исключении private-turn events из следующего context и очереди updates/jobs.
- [ ] 7.3 После выкладки byte-upload path и отдельного разрешения ротировать Telegram bot token, обновить runtime secret, перезапустить workload и проверить Telegram smoke без появления token в AI telemetry.
- [ ] 7.4 После отдельного разрешения на удаление инвентаризировать и удалить старые объекты `bot-voic/phoronis/`, затем проверить, что новые long-running операции очищают собственный key после success и failure.
