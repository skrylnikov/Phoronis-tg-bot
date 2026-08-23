## 1. Подготовка зависимостей и границ изменения

- [x] 1.1 Повторно проверить `git status`, diff и завершённость `stabilize-ai-context-and-local-prompts`, зафиксировав затронутые Langfuse/AI-файлы и отсутствие разрешения на reset/checkout; проверить результат read-only сравнением до начала правок
- [x] 1.2 Проверить актуальные patch-версии и peer dependencies для `@langfuse/tracing`, `@langfuse/otel` и `@opentelemetry/sdk-node`, удалить legacy `langfuse`, обновить `package.json` и `bun.lock`; проверить установку через `bun install --frozen-lockfile` и отсутствие unresolved peer dependency
- [x] 1.3 Обновить конфигурацию и `.env.example` с `LANGFUSE_TRACING_ENVIRONMENT`, сохранив keys/base URL и приоритет нового имени над `LANGFUSE_ENVIRONMENT`; проверить config-тестом и поиском отсутствие передачи старого environment в v5 runtime

## 2. OpenTelemetry lifecycle

- [x] 2.1 Создать production-only instrumentation module с однократным `NodeSDK` и `LangfuseSpanProcessor`, импортировать его из production entrypoint до запуска transport/scheduler; проверить `bun run typecheck` и отдельный импорт под Bun без побочного запуска unit-модулей
- [x] 2.2 Встроить `shutdownTelemetry` в `createRuntimeShutdown()` с использованием существующего `shutdownDrainMs`, идемпотентностью, обработкой rejection и timeout без остановки остальных компонентов; проверить расширенными тестами порядок, повторный SIGTERM и non-fatal failure
- [x] 2.3 Оставить v5 smart span filter по умолчанию и не включать auto-instrumentation инфраструктуры; проверить конфигурацию instrumentation review-поиском отсутствия `shouldExportSpan: () => true` и auto-instrumentation packages

## 3. Адаптация AI tracing API

- [x] 3.1 Заменить singleton legacy trace client в `src/ai/langfuse.ts` на helper active observation с `propagateAttributes`, whitelist безопасных metadata и нормализацией коротких строковых значений; проверить unit-тестом имена, session/user attributes и ограничение telemetry payload
- [x] 3.2 Перевести `chatGeneration()` с `LangfuseTraceClient`/`trace.update()` на v5 observation update без raw input/output и с корректным завершением observation; проверить focused-тестом latency, aggregate counters, prompt hash и отсутствие полного prompt/ответа
- [x] 3.3 Перевести обычный и guest caller на helper с именами `chat-generation`/`guest-generation`, сохранить guest query id, `persistResponse === false` и текущие response/quota пути; проверить focused AI-controller и guest tests
- [x] 3.4 Удалить все оставшиеся runtime-импорты legacy `langfuse`, `LangfuseTraceClient`, `langfuse.trace()` и v3 prompt/client API, не возвращая `getPrompt`; проверить `rg`-поиском по `src`, `package.json` и lock-файлу

## 4. Регрессионные проверки и совместимость

- [x] 4.1 Обновить Vitest-моки и тестовые fixtures для нового tracing helper-а, не включая реальный network в unit suite; проверить `bun run test -- src/__tests__` и отсутствие flaky зависимости от telemetry backend
- [x] 4.2 Добавить проверку privacy-контракта для user names, memories, retrieval context, raw messages и secret-like values; проверить, что в observation metadata остаются только whitelist-поля и агрегаты
- [x] 4.3 Проверить self-hosted compatibility для фактического `LANGFUSE_BASE_URL` и минимальной серверной версии v5; зафиксировать endpoint/version evidence или остановить apply до получения внешнего подтверждения
- [x] 4.4 Выполнить bounded Bun runtime smoke с тестовыми ключами/endpoint и проверить, что instrumentation стартует, AI generation не падает при недоступном Langfuse и tracing error логируется без секретов

## 5. Приёмка и rollout

- [x] 5.1 Выполнить полный локальный набор `bun run typecheck`, `bun run lint` и `bun run test`; исправить только ошибки в scope change и сохранить чистый отчёт проверок
- [x] 5.2 Выполнить bounded smoke с реальным Langfuse project для chat и guest generation, проверить observations с правильными names/session/user attributes, доставку на заданный base URL и отсутствие raw prompt в metadata
- [x] 5.3 Проверить graceful SIGTERM после создания observation: telemetry shutdown должен попытаться flush в пределах `SHUTDOWN_DRAIN_MS`, а process shutdown должен завершить остальные компоненты даже при timeout; зафиксировать runtime evidence
- [x] 5.4 Перед handoff повторно проверить diff, список файлов, отсутствие database migration и rollback-путь через предыдущий application artifact; показать OpenSpec status и полный verification summary
