## Why

Кратковременная недоступность TEI переводит embeddings в `not-ready`, после чего `/readyz` больше не перепроверяет зависимость и оставляет рабочий процесс исключённым из Service до рестарта. Повторный production-инцидент подтвердил, что временное восстановление pod не устраняет эту причину.

## What Changes

- Перепроверять PostgreSQL и embeddings при последующих readiness probes после временного отказа.
- Возвращать HTTP 200 автоматически после восстановления зависимостей, если остальные runtime-компоненты готовы и shutdown не начат.
- Сохранить HTTP 503 для действительно недоступных зависимостей, незапущенных runtime-компонентов и shutdown.
- Добавить regression-проверку перехода `ready → not-ready → ready` без рестарта процесса.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `runtime-readiness`: readiness самостоятельно восстанавливается после возобновления PostgreSQL или embeddings без рестарта приложения.

## Impact

- Код: `src/health-readiness.ts`.
- Проверки: `src/__tests__/health.test.ts`.
- Контракт: `openspec/specs/runtime-readiness/spec.md`.
- Зависимости, схема данных и публичные API не меняются.
