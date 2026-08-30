## 1. Regression Coverage

- [x] 1.1 Добавить в `src/__tests__/health.test.ts` последовательные проверки восстановления PostgreSQL и TEI на одном `RuntimeState`: первый probe возвращает 503, следующий успешный — 200 без рестарта; проверить командой `bun run test -- src/__tests__/health.test.ts`.

## 2. Readiness Recovery

- [x] 2.1 Обновить `getReadinessResponse()` так, чтобы до shutdown каждый probe перепроверял PostgreSQL и TEI, обновлял их состояния и возвращал результат существующего агрегированного runtime state; проверить focused-тестом, что startup/shutdown gates по-прежнему дают 503.

## 3. Verification

- [x] 3.1 Запустить `bun run test -- src/__tests__/health.test.ts`, `bun run typecheck` и `bun run lint`; все команды должны завершиться успешно.
