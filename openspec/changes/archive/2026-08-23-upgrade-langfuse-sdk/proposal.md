## Why

Проект использует legacy JS/TS SDK `langfuse@3.38.20`, тогда как актуальный официальный путь для JS/TS — прямой переход на SDK v5. Старый `Langfuse.trace()` и тип `LangfuseTraceClient` не соответствуют новой OpenTelemetry-модели, поэтому обновление нужно выполнить вместе с адаптацией создания и завершения observations, сохранив текущую наблюдаемость AI-генераций.

## What Changes

- **BREAKING** Заменить legacy-пакет `langfuse` на модульный tracing-набор JS/TS SDK v5: `@langfuse/tracing` и `@langfuse/otel`; добавить совместимый `@opentelemetry/sdk-node`. На момент подготовки proposal актуальная проверенная версия Langfuse-пакетов — `5.10.1`, OpenTelemetry Node SDK — `0.221.0`; окончательные patch-версии проверить при реализации.
- Инициализировать `NodeSDK` с `LangfuseSpanProcessor` один раз при старте приложения и корректно завершать/flush-ить его при graceful shutdown.
- **BREAKING** Перевести chat и guest generation с `langfuse.trace()`/`trace.update()` на v5 observations и propagation attributes, сохранив имена операций, `sessionId`, `userId` и безопасные telemetry-метаданные текущего контракта.
- Перенести настройку окружения на поддерживаемую v5 переменную `LANGFUSE_TRACING_ENVIRONMENT`; сохранить `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY` и `LANGFUSE_SECRET_KEY`.
- Проверить влияние v5 smart span filtering и явно зафиксировать поведение для tracing-операций бота; не добавлять экспорт инфраструктурных span-ов без подтверждённой необходимости.
- Обновить тестовые моки и regression/smoke-проверки так, чтобы они подтверждали typecheck, запуск Bun-runtime и фактическую доставку trace в Langfuse.
- Не возвращать runtime prompt management: после соседнего change Langfuse остаётся системой наблюдаемости, а локальные промпты и контракты ответов не меняются.

## Capabilities

### New Capabilities

- `langfuse-observability`: наблюдаемость AI-генераций через Langfuse JS/TS SDK v5 и OpenTelemetry с сохранением безопасного trace-контракта и корректным lifecycle runtime.

### Modified Capabilities

Нет. Изменяется реализация транспорта наблюдаемости, но пользовательские требования к AI-контексту, квотам, приватности и Telegram-ответам не меняются.

## Impact

- `package.json`, `bun.lock` и зависимости Langfuse/OpenTelemetry.
- `src/ai/langfuse.ts`, `src/ai/chat-generation.ts`, `src/ai/controllet.ts`, `src/ai/guest-generation.ts`, `src/index.ts`, конфигурация окружения и связанные тесты.
- Startup/shutdown lifecycle приложения на Bun; для self-hosted Langfuse потребуется сервер не ниже версии, совместимой с JS/TS SDK v5 (официальная матрица указывает минимум 3.63.0).
- Proposal предполагает сохранение уже имеющихся незакоммиченных изменений в AI-файлах и применение этого change поверх согласованного состояния `stabilize-ai-context-and-local-prompts`.
