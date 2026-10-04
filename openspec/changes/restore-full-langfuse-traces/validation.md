# Локальная проверка реализации

Дата: 04.10.2026. Продакшен не изменялся; пункт 5.3 остаётся открытым.

## Проверки

- `bun run typecheck`: успешно.
- Scoped Biome по 13 изменённым TypeScript-файлам: успешно.
- Релевантная Vitest suite: 11 файлов, 84 теста, все успешны.
- Bun 1.4.0: `bun install --frozen-lockfile --ignore-scripts` успешно, lockfile неизменен. Production Dockerfile также успешно установил зависимости с `--production --omit=dev --omit=optional --omit=peer` и выполнил Prisma generation внутри image.
- Scoped `git diff --check`: успешно. Полная проверка dirty worktree сообщает уже существовавшие trailing whitespace в `src/generated/prisma/*`; они не исправлялись этим change.

## Воспроизведение smoke

Использовать Bun 1.4.0 (версия production image). Скрипт создаёт локальный OTLP HTTP-приёмник и синтетический RouterAI transport: живые Telegram, RouterAI и Langfuse Cloud не вызываются, пользовательские данные и рабочие ключи не требуются. Экспорт остаётся реальным и пакетным.

```sh
rtk proxy bun run src/scripts/langfuse-smoke.ts
rtk proxy env BUILDX_CONFIG=/private/tmp/phoronis-langfuse-buildx docker build -t phoronis-langfuse-smoke:local .
rtk proxy docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,size=32m phoronis-langfuse-smoke:local bun run src/scripts/langfuse-smoke.ts
```

На этой машине системный Bun 1.3.9 не понимает текущую версию lockfile; для host smoke использован изолированный `/private/tmp/phoronis-bun-1.4/package/bin/bun`, без замены глобального runtime.

Финальный локальный image id: `sha256:50a8bf7f4283379b7ca6ca171067a75b3718b86275c5b6050ffcb7f51fceafb2`. Это проверочный image текущего dirty checkout, включающего параллельные изменения; он не публиковался и не является production deployment artifact.

Проверенные assertions: root observation и trace-level IO; два LLM-шага/один tool без повторного исполнения; фактическая response model и wrapped lite reasoning effort; provider/parameters/finish reason/TTFT/usage/cache/reasoning, explicit total без aggregate billing; parent links и session/user/prompt metadata; параллельные private/public запросы; private provider/tool errors, structured tool error, thrown tool error; публичный и private abort на незавершённом стриме после первого токена; partial/error/cancelled и ended spans; отсутствие secrets, data URLs и private sentinel во всём OTLP payload; отсутствие spans у untraced вызова; exporter HTTP 503 без повторной генерации; настоящий SIGTERM и flush через существующий `createRuntimeShutdown()` в budget 2 секунды.

Результат synthetic workload: 75 доставленных spans, 21 generation, 9 tools; 12 tool executions включают три ожидаемо не доставленных execution (untraced/outage). `privateExcluded`, `outageNonFatal`, `shutdownFlushed` = true. Raw payload не сохраняется.

## Наблюдение при реализации

`splitSystemMessages()` возвращает массив system messages. Прежняя сборка через `.join()` превращала его в `[object Object]`; теперь исходный массив передаётся в AI SDK с добавленным system message alias instructions. Metadata/provider options исходных сообщений сохраняются, root IO соответствует фактически переданным инструкциям и сообщениям.

## Production acceptance

Нужны отдельное разрешение на deployment, определённый публикуемый revision/image и обычный chat, guest, tool flow и private запрос. Проверить доставленные traces через API и UI, Input/Output таблицы, поколения/tools, private metrics без содержимого; записать production image digest и trace ids без текстов пользователей. Старые пустые traces backfill не получают.
