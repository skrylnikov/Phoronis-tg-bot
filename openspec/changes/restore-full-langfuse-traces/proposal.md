# Proposal

## Why

Production-трейсы chat/guest доходят до Langfuse, но содержат только агрегированные metadata: Input/Output пусты, LLM-вызовы не представлены как generations, а модель, токены и tools не видны. Это мешает разбирать качество ответов, расход токенов и ошибки многошаговой генерации.

## What Changes

- **BREAKING** Изменить контракт telemetry для обычных chat/guest-запросов: разрешить запись фактически переданных модели инструкций, сообщений и полученного ответа в специализированные `input`/`output`, с удалением секретов и ограничением размера. В metadata и обычные логи тексты не дублировать.
- Сохранить root observations `chat-generation`/`guest-generation`, заполнить их Input/Output и добавить вложенные `GENERATION` для фактических LLM-шагов и `TOOL` для вызовов инструментов.
- Передавать фактическую модель, параметры, доступный usage/cache usage, finish reason, latency/TTFT и безопасный статус ошибок/отмены. Не заменять отсутствующие метрики выдуманными нулями или стоимостью.
- Сохранить session/user/thread-корреляцию, окружение и сведения о локальном prompt/cache boundary на root и дочерних observations.
- Для private mode сохранять только технические метрики и явную отметку об исключённом содержимом; секреты, бинарные вложения и служебные объекты исключать во всех режимах.
- Ограничить интеграцию chat/guest и вложенными LLM/tools. `/ask` с `persistResponse: false`, vision, voice beautifier/summarizer, фоновые задачи и context compaction сохраняют текущий tracing-контракт.
- Проверить реальный экспорт observations под Bun и отображение Input/Output в Langfuse, включая ошибки tools и недоступность exporter.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `langfuse-observability`: содержательные root observations, вложенные LLM/tools, метрики и ошибки, правила исключения private payload и секретов.
- `ai-context-and-prompts`: разрешить диагностический снимок фактического model input/output для неприватных chat/guest в отдельных полях Langfuse, сохранив локальное владение промптами и запрет raw payload в обычных логах/cache metadata.

## Impact

- Основные точки: `src/ai/langfuse.ts`, `src/ai/chat-generation.ts`, `src/ai/controllet.ts`, `src/ai/guest-generation.ts`, `src/instrumentation.ts` и связанные tests.
- Зависимости: совместимая с `ai@7` официальная `@langfuse/vercel-ai-sdk` для per-call telemetry; проверить совместимость с существующими Langfuse/OpenTelemetry и Bun до выбора точной версии. Глобальный tracing всех AI-вызовов не включать.
- Langfuse начнёт хранить тексты неприватных запросов/ответов, уже использованные в выбранном model call; доступ проекта Langfuse станет границей доступа к этим данным. Private retention в PostgreSQL и остальные бизнес-правила не меняются.
- Изменение относится к новым observations после реализации; исторические пустые input/output не восстанавливаются. Deployment и production smoke выполняются отдельным разрешённым этапом.
