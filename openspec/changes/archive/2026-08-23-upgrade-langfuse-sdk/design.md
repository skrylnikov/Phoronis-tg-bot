## Context

См. `proposal.md` и `specs/langfuse-observability/spec.md` для мотивации и внешнего контракта. Сейчас `src/ai/langfuse.ts` создаёт singleton `Langfuse` из пакета v3, `controllet.ts` и `guest-generation.ts` вызывают `langfuse.trace()`, а `chat-generation.ts` добавляет telemetry через `trace.update()`.

В v5 tracing разделён на `@langfuse/tracing` и `@langfuse/otel`, а OpenTelemetry SDK должен быть инициализирован до создания observations. В проекте уже есть единый `src/index.ts` и тестируемый `createRuntimeShutdown()` с ограниченным drain budget. Соседний change `stabilize-ai-context-and-local-prompts` оставляет Langfuse только для tracing; его незакоммиченные изменения в AI-файлах нельзя затирать.

## Goals / Non-Goals

**Goals:**

- Выполнить прямой переход с v3 на актуальную major-версию v5 без промежуточной фиксации на v4.
- Сохранить один наблюдаемый root observation для persisted chat/guest generation, текущие имена операций и безопасный telemetry-контракт.
- Подключить OpenTelemetry один раз на production startup и корректно завершать его в существующем shutdown lifecycle.
- Сделать Bun-runtime, unit-проверки и реальную доставку trace проверяемыми.

**Non-Goals:**

- Не добавлять `@langfuse/client`, prompt management, datasets или scoring: в текущем runtime эти возможности не нужны.
- Не включать auto-instrumentation инфраструктурных HTTP, database или queue span-ов.
- Не менять AI-контекст, локальные промпты, модели, квоты, privacy-правила и Telegram transport.
- Не выполнять миграцию или удаление исторических traces в Langfuse.

## Decisions

### 1. Использовать модульный v5 tracing stack

В `package.json` удалить legacy `langfuse` и добавить `@langfuse/tracing`, `@langfuse/otel` и `@opentelemetry/sdk-node`. На момент подготовки proposal registry возвращает `5.10.1` для обоих Langfuse-пакетов и `0.221.0` для Node SDK; при реализации точные patch-версии повторно проверить и зафиксировать в `bun.lock`, сохраняя принятую в проекте политику semver.

`@langfuse/client` не добавляется, потому что prompt management уже вынесен из runtime. Переход сразу на v5 выбран вместо последовательного v3 → v4 → v5: официальный upgrade path рекомендует для v3 сразу выполнить оба набора breaking changes.

### 2. Отделить OpenTelemetry initialization от AI helper-а

Создать отдельный production-only instrumentation module, который создаёт `NodeSDK` с `LangfuseSpanProcessor` и запускает его один раз. `src/index.ts` импортирует этот модуль до запуска bot transport и scheduler. AI-код импортирует только функции создания observations и не запускает SDK при импорте тестируемого модуля.

Используется стандартный v5 smart span filter. Специальный `shouldExportSpan: () => true` не добавляется: текущая функциональность создаёт Langfuse observations напрямую, а экспорт всех внутренних Bun/HTTP/DB span-ов не является контрактом и увеличил бы шум.

Рассматривалась инициализация прямо в `src/ai/langfuse.ts`, но она создаёт побочные эффекты во время unit-тестов и делает порядок импорта менее надёжным. Рассматривался flush после каждого ответа, но он добавляет latency и не нужен при общем shutdown lifecycle.

### 3. Обернуть одну генерацию в active observation

Вместо прежнего singleton trace client добавить небольшой helper уровня AI, который:

1. создаёт `startActiveObservation()` с именем `chat-generation` или `guest-generation`;
2. через `propagateAttributes()` назначает `userId`, `sessionId` и безопасные metadata в начале callback;
3. передаёт observation в `chatGeneration()` для финального telemetry update;
4. позволяет v5 автоматически завершить observation после успешного или ошибочного callback.

`persistResponse === false` сохраняет текущий путь без обязательного tracing. Текущий `trace.update({ metadata })` заменяется обновлением observation без записи полного input/output. Числовые telemetry-поля перед propagation нормализуются в короткие строковые значения, поскольку v5 требует для propagated metadata `Record<string, string>` с ограничением размера. Имена metadata остаются существующими camelCase-ключами.

Ручные `startObservation()`/`.end()` не выбираются как основной путь: они ближе к текущему коду, но требуют гарантировать `.end()` во всех ветках, включая исключения и abort. Active callback одновременно сохраняет контекст OpenTelemetry и закрывает observation.

### 4. Сохранить конфигурацию ключей и явно мигрировать environment

Проверка обязательных public/secret keys и base URL остаётся в конфигурации приложения, но legacy `environment` property удаляется из v3-конфига. В deployment env и `.env.example` используется `LANGFUSE_TRACING_ENVIRONMENT`; если одновременно присутствуют старый `LANGFUSE_ENVIRONMENT` и новый ключ, читается только новый ключ. `LANGFUSE_BASE_URL` продолжает поддерживать cloud и self-hosted endpoint.

Вызов `LangfuseSpanProcessor` получает credentials/base URL из проверенной конфигурации либо стандартных env, но не дублирует собственный prompt/client singleton. Self-hosted endpoint проверяется на совместимость с требованиями v5 до smoke-теста.

### 5. Встроить telemetry shutdown в общий shutdown budget

Расширить `RuntimeShutdownDependencies` отдельным `shutdownTelemetry` callback, передаваемым из `src/index.ts`. Он вызывается после остановки входящего transport и draining рабочих компонентов, когда новые AI-observations больше не должны появляться. Вызов `NodeSDK.shutdown()` ограничивается текущим `shutdownDrainMs`; timeout или rejection логируется как telemetry-specific ошибка и не отменяет отключение embeddings, database и остальных компонентов.

Идемпотентность сохраняется на уровне `createRuntimeShutdown()`: повторный SIGINT/SIGTERM не запускает второй shutdown telemetry. Unit-тесты должны проверять порядок, timeout и non-fatal rejection.

### 6. Проверять изменение на трёх уровнях

- Статическая проверка: в runtime не остаётся импорта legacy `langfuse`, вызовов `langfuse.trace()` и `LangfuseTraceClient`; prompt fetching также не возвращается.
- Автоматическая проверка: тесты helper-а и caller-ов подтверждают имена, session/user attributes, безопасные metadata и отсутствие trace при `persistResponse === false`; отдельные тесты покрывают shutdown.
- Runtime-проверка: `bun run typecheck`, `bun run lint`, `bun run test`, bounded запуск приложения/минимального tracing smoke под Bun и тестовый AI-запрос с проверкой появления `chat-generation`/`guest-generation` в настроенном Langfuse endpoint. При self-hosted deployment smoke выполняется против фактического `LANGFUSE_BASE_URL`.

## Risks / Trade-offs

- **[Риск]** `@langfuse/otel` документирован для Node.js ≥20, а приложение запускается через Bun → **Митигировать** отдельным Bun smoke-тестом до deployment; при несовместимости остановить apply на этой технической границе, не маскировать проблему отключением tracing.
- **[Риск]** Self-hosted Langfuse старее минимально совместимой версии не принимает observations/API v2 → **Митигировать** проверить server version/base URL до миграции и явно зафиксировать результат; для Cloud отдельная серверная миграция не нужна.
- **[Риск]** `propagateAttributes()` отбрасывает слишком длинные или нестроковые metadata → **Митигировать** передавать только whitelist текущих telemetry-ключей, сериализовать числа и ограничивать значения; raw prompt и пользовательские payload не включать.
- **[Риск]** Неправильный порядок импорта не зарегистрирует span processor до первого trace → **Митигировать** выделить instrumentation module, импортировать его из production entrypoint первым и подтвердить доставку реальным smoke-тестом.
- **[Риск]** Shutdown telemetry задержит остановку процесса → **Митигировать** использовать существующий `shutdownDrainMs`, ловить rejection/timeout и не ставить flush в критический путь пользовательского ответа.
- **[Риск]** Новый change пересекается с текущими незакоммиченными AI-изменениями → **Митигировать** перед apply повторно проверить `git diff`, не использовать reset/checkout и менять только согласованные участки; после этого прогнать полный typecheck/test.

## Migration Plan

1. Перед реализацией повторно проверить `git status`, diff и завершённость `stabilize-ai-context-and-local-prompts`; не включать чужие изменения в scope и не откатывать их.
2. Обновить зависимости и lock-файл, затем проверить peer dependencies, TypeScript и возможность запуска OpenTelemetry под Bun.
3. Добавить instrumentation и shutdown hook, заменить legacy AI helper и адаптировать chat/guest callers с сохранением telemetry contract.
4. Обновить `.env.example` и deployment configuration с `LANGFUSE_TRACING_ENVIRONMENT`; проверить фактический base URL и совместимость self-hosted сервера.
5. Выполнить unit/lint/typecheck проверки, затем bounded runtime smoke с реальным Langfuse project, проверив обе категории observation и отсутствие raw prompt в metadata.
6. Выпустить как обычное приложение без database migration. Rollback — возврат предыдущего application artifact и lock-файла; новые traces не требуют обратной миграции данных.

## Open Questions

Технических вопросов, меняющих спецификацию или выбранный подход, нет. Точные patch-версии зависимостей и конкретный способ запуска bounded smoke уточняются во время apply по фактическому registry и deployment environment.
