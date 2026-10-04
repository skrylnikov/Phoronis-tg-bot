# Проверка реализации и deployment

Дата: 04.10.2026. Deployment разрешён пользователем. Проверки Telegram end-to-end для пункта 5.3 фиксируются отдельно от диагностических вызовов из pod.

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

## Изолированный релиз

Чтобы не включать соседние изменения Jev/model selection, релиз собран в `/private/tmp/phoronis-langfuse-release` от production baseline `b44155b`. Из dirty checkout перенесены только tracing и соответствующие проверки; модельные идентификаторы, Prisma schema/generated client, scheduler и fact analyzer остались на baseline. Основной dirty checkout не сбрасывался и не коммитился.

- `4ec04f7`: основная реализация tracing. Полный lint, typecheck, 67 Vitest-файлов / 330 тестов и smoke прошли. CI quality с PostgreSQL integration прошёл; Trivy выявил шесть HIGH в трёх patch-зависимостях.
- `6535de6`: исправленные `@grpc/grpc-js@1.14.5`, `fast-uri@4.1.4`, `undici@8.10.2`; повторные 330 тестов / typecheck / lint / smoke прошли. CI `37227281358` полностью успешен, включая Trivy.
- `4837f80`: production smoke выявил `process.command_args` в OpenTelemetry resource metadata (там находился код запуска диагностического `bun -e`). Resource metadata теперь содержит только whitelist service/deployment/SDK; regression smoke проверяет отсутствие runtime-content sentinel при сохранении service name. Typecheck/lint/smoke прошли; CI `37227467515` полностью успешен.

Первые диагностические запросы использовали production RouterAI и экспорт в production Langfuse; Telegram-сообщения и записи пользовательских данных не создавались. API/UI подтвердили публичные root IO, guest root IO, фактические модели/usage, два model calls и weather tool. Private root/generations/tool IO отсутствовали; обнаруженный диагностический sentinel находился только в process command arguments и исправлен следующим релизом. Финальная проверка whitelist и image фиксируется ниже.

## Финальный rollout

- Release commit: `4837f80dc9389f1e98801a37bdf402bfd7abf7a6`.
- Image: `ghcr.io/skrylnikov/phoronis-tg-bot:master-1791141283-4837f80dc938@sha256:a21a508ae8b2ccc2d20b62eb6fe272add7172979adddd768bbd8875d959f6c7f`.
- Flux infra commit: `8d9a72d29ab5b6503a37d5d24d10fe0b78bc5f3c`; apps reconciliation и deployment rollout успешны.
- Pod: `phoronis-55f87b47c8-dm277`, Running 1/1, без рестартов. Readiness HTTP 200, все пять компонентов ready. Telegram webhook `https://phoronis.dskr.dev/telegram/webhook`, pending updates 0, last error отсутствует.
- В ходе rolling update первый повторный smoke попал в старый pod. Финальный smoke выполнен по точному имени нового pod с проверкой наличия `resourceSafeKey` в установленном коде.
- Финальные диагностические trace ids: chat `42008edcd927d16529453930fd5b398c`; guest `c2846ad606f0890ea8dffc4469bb8ef7`; private `ebaf38072209cefc1bad84de76ab70cd`. Все три AI-вызова вернули непустой ответ.
- API финальных chat/guest подтвердил root Input/Output, generation Input/Output, фактические модели/parameters, usage/cache/reasoning и ended spans; у chat два поколения и `get_weather` с IO и правильным parent. Private root и все children без IO, но с моделями/parameters/usage. Во всём сериализованном API-представлении всех трёх traces отсутствуют private sentinel и process command arguments. Проверки выполнены с учётом минутного hobby API rate limit (429).
- UI Langfuse подтвердил строки финальных chat/guest с заполненным IO; private строка показывает No value. Дерево chat содержит два generation и tool; generation открывается с типом Generation и моделью, tool имеет отдельную карточку. Старые пустые traces не изменяются.

Пункт 5.3 остаётся открыт до полной проверки живых Telegram chat/guest/private путей: диагностические запросы вызвали production `withAiObservation` + `chatGeneration`, но не прошли через Telegram controllers, durable context и quota reservation. Пользователю направлен запрос на тестовые сообщения; отсутствие ответа не трактуется как подтверждение E2E.
