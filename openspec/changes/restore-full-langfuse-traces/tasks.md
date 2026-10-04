# Tasks

## 1. Совместимость и границы интеграции

- [x] 1.1 Перечитать dirty diff, callers `chatGeneration()` и версии AI SDK/Langfuse, добавить совместимую `@langfuse/vercel-ai-sdk` без обновления model registry; проверить peer dependencies, `bun install --frozen-lockfile` и `bun run typecheck`.
- [x] 1.2 Подключить singleton integration через per-call `telemetry.integrations` только для tracing-enabled chat/guest; проверить реальный Bun smoke на локальном exporter и regression-тест, что `/ask`, vision, voice, compaction и фоновые вызовы не получают новую telemetry; не использовать global `registerTelemetry()`.

## 2. Root Input/Output и корреляция

- [x] 2.1 Передать private mode в tracing policy из chat/guest, сохранить session/user/thread и добавить короткие доступные chat/message/update identifiers; проверить тестом обычный/guest/private path и параллельные private/public ответы без смешивания attributes.
- [x] 2.2 Заполнить root observation IO и совместимый trace-level IO снимком фактических instructions/messages после сборки prompt и итоговым текстом после стрима; проверить `chat-generation` fixtures, что alias instructions включены, роли/порядок совпадают с model call, output записан после окончания стрима и соответствует результату до Telegram-форматирования.
- [x] 2.3 Сохранить технические root metadata и обновить краткое описание tracing в README: scope, содержимое обычного запроса, private exclusion, предел IO и отсутствие backfill; проверить fixtures prompt hash/version/cache boundary и соответствие документации обоим delta-specs.

## 3. Вложенные generations/tools, usage и lifecycle

- [x] 3.1 Проверить native integration на фикстуре с двумя LLM-шагами и одним tool; устранить только реальные пробелы mapping и проверить exported `GENERATION`/`TOOL`, parent trace, имя/tool call id, очищенные IO и отсутствие дублированных model/tool executions.
- [x] 3.2 Сверить и при необходимости дополнить model/provider/parameters, finish reason, TTFT и usage/cache/reasoning mapping; проверить основные и wrapped lite-модели, multi-step totals без двойного подсчёта и отсутствие выдуманных нулей/стоимости при неполном provider usage.
- [x] 3.3 Завершать root и children при provider exception, thrown/structured tool error и abort после первых токенов; проверить error/cancellation/partial статусы, окончание spans, безопасную диагностику и сохранение исходного AI error без повторного вызова.

## 4. Очистка содержимого и устойчивость telemetry

- [x] 4.1 Добавить общий sanitizer диагностических копий: известные runtime secrets, token patterns, credential fields/URLs, signed links и binary/runtime objects; ограничить input/output до 128 KiB UTF-8 с валидным preview и явным усечением; проверить sentinel secrets в вложенном JSON/тексте, data URL, циклические объекты, Unicode и неизменность model input.
- [x] 4.2 Применить private exclusion и sanitization на общем export boundary, включая root trace IO, native raw attrs, tool args/results, events и status/exception fields; проверить реальные exported spans, отсутствие sentinel private text во всех полях, безопасные метрики и отключённый media upload.
- [x] 4.3 Изолировать ошибки observation creation/update, sanitizer и exporter от основного ответа; проверить inject-failure сценарии, ровно один model/tool execution, сохранение ответа, безопасные технические логи и отсутствие raw span/body/header dumps в production logging.

## 5. Сквозная проверка и приёмка

- [x] 5.1 Выполнить `bun run typecheck`, scoped Biome по изменённым файлам и релевантную Vitest suite для tracing/chat/guest/private/streaming/shutdown; отдельно зафиксировать baseline failures и проверить `git diff --check` без изменения чужого dirty diff.
- [x] 5.2 Проверить production image и реальный batch export под Bun через локальный OTLP-приёмник: root/children IO, type/parent/model/usage, private exclusion, exporter outage и SIGTERM flush в текущем budget; сохранить воспроизводимую команду и безопасные результаты, не используя живую Telegram-сессию для локального smoke.
- [ ] 5.3 После отдельного разрешения на deployment выполнить production acceptance обычного chat, guest и tool flow: проверить доставленные trace через API и UI, заполненные колонки Input/Output и карточки generations/tools; отдельным private запросом подтвердить метрики без содержимого. Зафиксировать image digest и trace ids без копирования пользовательских текстов; до этого не отмечать production acceptance выполненной.
