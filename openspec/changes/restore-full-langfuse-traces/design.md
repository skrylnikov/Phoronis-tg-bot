# Design

## Context

См. `proposal.md` и delta-specs. Сейчас production использует Bun 1.4.0, `ai@7.0.77`, `@langfuse/tracing`/`@langfuse/otel@5.10.1` и NodeSDK 0.221.0. `startActiveObservation()` создаёт root типа span; `chatGeneration()` обновляет только агрегированные metadata. Ни input/output, ни lifecycle интеграция AI SDK не подключены. Проверка production 04.10.2026 показала 35 доставленных root traces за 48 часов и пустые input/output; проблема в instrumentation, а не доказанной потере доставки.

Chat и guest используют общий `chatGeneration()`, который собирает инструкции с `aliasContextInstructions`, вызывает `streamText()` и дожидается итогового текста. Обычный controller пропускает tracing при `persistResponse: false`; guest и chat имеют свои признаки private mode. Модель выбирается до generation, включая lite fallback по квоте. Контекст строится до текущего root, поэтому context compaction не становится дочерним LLM-шагом этого change.

В рабочем дереве параллельно меняются model routing и fact/alias analysis. При apply перечитать фактические версии и callers; этот change не выбирает модели и не изменяет фоновые операции.

## Goals / Non-Goals

**Goals:**

- Использовать одну официальную интеграцию lifecycle вместо собственной реализации LLM/tool span orchestration.
- Заполнить поля root и вложенных операций, сохранить streaming, квоты и число реальных вызовов.
- Обеспечить единые правила sanitization на всём экспортируемом trace и изоляцию параллельных private/public ответов.

**Non-Goals:**

- Собственная система pricing, хранение копий telemetry в PostgreSQL, UI бота, новые provider/model настройки и изменение prompt management.
- Глобальная регистрация tracing всех AI SDK calls, восстановление исторических payload и распространение содержимого private mode в Langfuse.

## Decisions

### 1. Официальная AI SDK 7 integration подключается per-call

Добавить совместимую `@langfuse/vercel-ai-sdk` и передать её через `telemetry.integrations` только в обе ветки `streamText()` общего `chatGeneration()` при наличии разрешённого root observation. Singleton интеграции не должен запускать SDK/network при импорте тестируемого helper. Для пути без root явно отключить telemetry. Не использовать глобальный `registerTelemetry()`: в AI SDK 7 он включает telemetry по умолчанию для всех вызовов и расширяет согласованный scope.

Официальная интеграция создаёт LLM/model-call и tool spans, которые экспортирует существующий `LangfuseSpanProcessor`. Не дублировать эти шаги ручными `startObservation()` или обёртками всех tools. Приложение заполняет только root и специфичные для него metadata, которых нет у интеграции. Весь контекст корреляции устанавливать через `propagateAttributes()` до вложенной генерации; root и потомки наследуют user/session/thread и безопасную версию prompt/cache boundary. Сохранять root имена.

Проверенные сведения: версия integration 5.10.1 опубликована и совместима с `ai >=7 <8`, `@opentelemetry/api ^1.9.0`; актуальный registry latest на 04.10.2026 — 5.11.1. Предпочтительно согласовать integration с установленной линейкой 5.10.1, без обновления всего AI-стека. Точную версию зафиксировать в lockfile после проверки peer dependencies. Integration указывает Node.js >=22, а приложение запускается под Bun: обязательный smoke на Bun и production image до rollout, без заявления совместимости по одному typecheck.

Источники: [официальная Langfuse integration](https://langfuse.com/integrations/frameworks/vercel-ai-sdk), [per-call пример в README](https://github.com/langfuse/langfuse-js/blob/main/packages/vercel-ai-sdk/README.md), installed `node_modules/ai/dist/index.d.ts` (`TelemetryOptions.integrations`, `recordInputs`, `recordOutputs`). Старый рецепт AI SDK 6 с одним `experimental_telemetry.isEnabled` не заменяет integration для AI SDK 7.

### 2. Root Input/Output отражают фактический запрос и итоговый результат

Снимать input в `chatGeneration()` после `splitSystemMessages()` и добавления `aliasContextInstructions`: `{ instructions, messages }`. Не снимать более ранний `rawMessages` из controller и не читать дополнительные сведения из базы для telemetry. У многошагового ответа root описывает первоначальный запрос и окончательный ответ; integration показывает вход/выход каждого последующего шага, включая полученные tool results.

Заполнять root `input`/`output` через observation update. Для таблицы Traces также заполнить совместимые trace-level IO существующим `setTraceIO()` на root теми же очищенными значениями; этот SDK-метод deprecated, но предназначен для совместимости trace-level IO. Корреляционные атрибуты через него не передавать. При smoke проверить обе поверхности — trace detail/list и observation detail — а не только наличие поля на generation.

Root output обновляется после `collectStreamedText()` итоговым текстом до Telegram markdown/разбиения. Частичный ответ допускается только с отметкой `partial` при ошибке/отмене. Root не завершается успешно до окончания стрима. Root технические metadata: текущие счётчики, latency/TTFT, finish reason, prompt hash/version, thread/cache boundary и короткие доступные идентификаторы chat/message/update. Служебные объекты Context не сериализуются.

### 3. Private policy задаётся явно и наследуется вложенными observations

Передать private mode из обоих callers в tracing options и общий generation. Для public/default запроса включить IO; для private запроса использовать `recordInputs: false`, `recordOutputs: false` и техническую отметку `contentExcludedReason: private-mode`. Root также не получает содержимого. Параллельные запросы используют свою async-context policy, без изменяемого глобального флага.

Запрет private content распространяется на tool args/results, request/response bodies, reasoning text, exception/status messages и события. Если SDK flag не исключает какое-либо поле, отфильтровать его на общем export boundary. Проверка действительного exported span обязательна: mock на вызов `recordInputs: false` недостаточен. Технические идентификаторы, модель, числа usage и tool name допустимы; тексты private mode не копируются в Langfuse и не требуют отдельной интеграции семидневной очистки.

Альтернатива — экспортировать private содержимое и синхронизировать его удаление из внешнего сервиса — отвергнута: добавляет lifecycle и меняет обещание private retention без запроса пользователя.

### 4. Одна очистка telemetry на export boundary

Для root projection и всех дочерних spans использовать общий небольшой sanitizer, размещённый в существующем tracing-модуле или одном соседнем модуле при необходимости. Передавать только копию диагностических данных; модель и tools получают исходные значения. Очистка удаляет известные непустые runtime secrets, Authorization/cookie/credential fields, распознаваемые token patterns, Telegram token URLs и credential-bearing/signed служебные URLs. JSON-подобные данные сохраняют структуру/роли; bytes, base64/data URLs и runtime/API objects заменяются описанием исключения.

Настроить существующий processor `mask` для поддерживаемых IO/metadata attributes и отключить ненужный media upload. Не считать `mask` универсальной гарантией: проверить raw AI SDK attrs, span events и status/exception fields. Если эти поля обходят mask, минимальный processor guard очищает их до экспортирования, сохраняя семантику spans. Не добавлять отдельную собственную tracing-platform. У private span guard оставляет только безопасные технические поля и удаляет все content-bearing attributes/events. Debug span dump не включать в production; ошибки exporter логировать с техническими полями без body/header dumps.

Разумный предел снимка: 128 KiB UTF-8 на каждое input/output после очистки. Превышение сохранять как валидную диагностическую структуру с ограниченным preview, `truncated: true` и `originalBytes`, без обрезанного JSON или сломанного Unicode. Размер полного исходного запроса отдельно отражают текущие числовые метрики. Это предел telemetry, не контекста модели. Для обычных запросов ниже предела содержимое сохраняется целиком после redaction. Sanitize/serialize failure исключает содержимое с причиной и безопасным логом.

### 5. Usage и ошибки берутся из реального lifecycle

Пусть integration владеет generations/tools, model/provider, step usage, finish reason и timings. Сверить экспортируемые поля с RouterAI response и текущими wrapped models, включая lite reasoning effort. Cache/reasoning usage записывать только когда provider действительно их вернул; заменить постоянное `providerCacheRead/Write: unavailable` фактическими значениями лишь при наличии данных. Не писать aggregate usage вторым billable generation. Root агрегаты технические и не участвуют в двойном подсчёте.

Стоимость считать средствами Langfuse только при корректном model matching и наличии тарифов. Отсутствие цены не блокирует трассировку; никаких локальных выдуманных цен или конвертации символов в токены.

У ошибок generation/tool сохранить безопасные code/type/status; raw request body, response headers и private error message не экспортировать. Structured tool error должен остаться видимым как неуспешный результат, даже когда execute не выбрасывает exception. Abort помечается как cancellation/partial, а не успешный полный ответ. Ошибка tracing не вызывает повтор model/tool и не маскирует исходную ошибку AI. Использовать существующий shutdown budget и batch export, без обязательного synchronous flush после каждого ответа.

## Risks / Trade-offs

- [Риск] Langfuse становится хранилищем содержимого обычных chat/guest, включая разрешённый контекст, реально отправленный модели → отражено в изменённой спецификации; secrets/private content исключены, payload ограничен, обычные логи остаются агрегированными.
- [Риск] Integration/processor по-разному обрабатывают raw attributes, errors и media → проверить экспорт с sentinel secrets и private text на реальных SDK spans, отключить media upload и закрыть обход mask до выпуска.
- [Риск] Новый adapter требует Node.js >=22, а runtime — Bun → Bun/export/container smoke является обязательным gate; при несовместимости не выключать tracing молча и не считать apply завершённым.
- [Риск] Избыточные spans, неверная parent связь или двойной usage → принять fixture с двумя LLM-шагами и одним tool, проверить type/parent/usage в exported spans и UI.
- [Риск] Большой контекст повышает объём и latency telemetry → фиксированный предел IO, batching и явное усечение; обычный ответ не ждёт сеть exporter.
- [Риск] Другой активный change редактирует соседние AI-файлы → перечитать diff перед apply; не изменять model registry/fact pipeline и сохранить чужую работу.

## Migration Plan

1. Реализовать новый telemetry contract и обновить unit/integration fixtures, не затрагивая Prisma schema или сохранённые messages.
2. Выполнить typecheck, scoped lint, релевантные tests, реальный Bun export smoke с локальным приёмником и совместимость dependency install/container. Проверить негативные сценарии приватности, exporter failure и out-of-scope callers.
3. После отдельного разрешения на deployment выложить образ с сохранением возможности вернуть предыдущий digest. В Langfuse проверить обычный chat, guest, tool flow и private response через реально доставленные traces и UI Input/Output.
4. Прежние пустые fields не backfill-ить: достоверный input старых generation не сохранён. При rollback вернуть предыдущий образ; уже доставленные новые traces автоматически не удаляются.
