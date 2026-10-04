# Validation

Проверки выполнены 4–5 октября 2026 года. Это отчёт о локальном apply; deployment и production replay не выполнялись.

## Baseline и границы change

- До apply checkout уже содержал изменения model routing, Jev/DecisionReview и `restore-full-langfuse-traces`. Снимок tracked diff сохранён в `/private/tmp/phoronis-alias-apply-baseline.patch`; существующие untracked файлы сохранены.
- Этот change не меняет Prisma schema, миграции, generated client, lockfile и выбор utility-модели. Изменения в пересекающихся AI-файлах сохраняют подготовленную ранее model/Jev/tracing логику. Весь `git diff` checkout включает чужой baseline и не является самостоятельным diff этого change.
- До исправления три alias-регрессии воспроизведены focused tests: подмена запрошенного имени другим сохранённым alias, запрещённое профильное обращение и потеря повторных snapshots при compaction. Результат исходного прогона: 3 failed / 13 passed.
- Повтор regression suites: `rtk proxy bun run test -- src/__tests__/my-alias-tool.test.ts src/__tests__/user-alias.test.ts src/__tests__/ai-thread-context-builder.test.ts`; те же сценарии входят в итоговый общий зелёный прогон.
- Плавающее окно воспроизведено с исходной реализацией из HEAD: `rtk proxy bun /private/tmp/phoronis-original-window-repro.ts`. Первая попытка читает IDs 30…1, retry — 90…61, `stable: false`. Теперь PostgreSQL fixture проверяет неизменные IDs и исключение поздно доставленного сообщения.
- Рабочий локальный PostgreSQL на порту 5433 недоступен (`ECONNREFUSED`). Проверки БД выполнены в отдельном контейнере `phoronis-alias-check`, pgvector/PostgreSQL 18, loopback-порт 55435, база `phoronis_alias_test`. Все существующие 28 миграций применены только туда. Production БД не изменялась.

## Локальные проверки

| Проверка | Команда | Результат |
| --- | --- | --- |
| TypeScript | `rtk proxy bun run typecheck` | PASS |
| Unit/regression | `rtk proxy bun run test` | 73 suites, 390 tests PASS (policy v2) |
| PostgreSQL | `rtk proxy env DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55435/phoronis_alias_test RUN_ANALYSIS_DB_TESTS=1 bun test src/__tests__/analysis-recovery.integration.test.ts src/__tests__/user-alias.integration.test.ts` | 4 tests, 47 assertions PASS |
| CLI help | `rtk proxy bun run analysis:retry --help` | PASS |
| OpenSpec | `rtk proxy openspec validate repair-user-analysis-and-alias-context --strict` | PASS |
| Whitespace | `rtk proxy git diff --check -- . ':!src/generated/prisma'` | PASS; generated файлы относятся к baseline |
| Scoped Biome | Команда ниже | 39 файлов PASS |

```sh
rtk proxy bunx biome check \
  src/domain/user/analysis-window.ts src/domain/user/analysis-stage.ts \
  src/domain/user/owner-alias.ts src/domain/user/aliases.ts \
  src/domain/user/fact-analyzer.ts src/domain/user/verify-candidates.ts \
  src/domain/user/decision-review.ts \
  src/repositories/message-repository.ts src/repositories/background-job-repository.ts \
  src/repositories/user-fact-repository.ts src/repositories/user-alias-repository.ts \
  src/application/user-message-analysis.ts src/application/analysis-retry.ts \
  src/scripts/analysis-retry.ts src/background-job-runner.ts \
  src/payment-background-jobs.ts src/controllers/process-message.ts \
  src/ai/controllet.ts src/ai/alias-context.ts src/ai/tools/my-alias.ts \
  src/ai/tools/user-info.ts src/ai/thread-context.ts src/ai/jev.ts \
  src/__tests__/analysis-window.test.ts src/__tests__/analysis-stage.test.ts \
  src/__tests__/analysis-retry.test.ts src/__tests__/analysis-recovery.integration.test.ts \
  src/__tests__/ai-controller-idempotency.test.ts src/__tests__/ai-thread-context-builder.test.ts \
  src/__tests__/background-job-runner.test.ts src/__tests__/fact-analyzer.test.ts \
  src/__tests__/message-analyzer.test.ts src/__tests__/my-alias-tool.test.ts \
  src/__tests__/payment-background-jobs.test.ts src/__tests__/privacy-runtime.integration.test.ts \
  src/__tests__/user-alias-flow.integration.test.ts src/__tests__/user-alias.test.ts \
  src/__tests__/user-info-tool.test.ts package.json
```

Vitest покрывает abort/lease/shutdown, безопасные stage errors, пустое окно, квоту, грамматику owner-команд и все пути alias-проекции. SQL fixtures дополнительно проверяют реальные условные updates, dry-run без мутаций, конкурентный replay/создание/противоречие, сохранность свежего embedding/weight, отдельные факты одного сообщения и однократное усиление evidence. Это не доказательство реального provider-поведения.

## Первичные реальные provider-проверки (policy v1)

Запросы направлялись к RouterAI и TEI через существующий pod без экспорта credentials. Использованы только синтетические сообщения, запись результатов — в изолированной локальной БД. Bot API, production queue, quotas и aliases не изменялись. Utility — `openai/gpt-6-luna`, verifier — `typesafe/jev-1.13-20260917`; production image всё ещё использует прежнюю utility-модель.

- Полный анализ 30 сообщений с самоназыванием и входящим reply сохраняет реальный факт и alias `Дима` как CANDIDATE с одним accepted автором. Extraction укладывается в 60 секунд, verification — в 30, вся попытка — в 180.
- Повтор того же закреплённого окна не добавляет alias evidence второй раз. Owner-команда сразу выбирает `Саша`.
- Отрицательный пример «Передай Диме привет» отвергается Jev (support 0.09 в контрольном прогоне).
- Независимый incoming reply извлекается с фактическими source ID/author и передаётся verifier. В контрольных прогонах support был 0.70–0.83 при пороге 0.90: второе evidence не сохраняется и alias остаётся CANDIDATE. Порог и критерий двух авторов не ослаблены; автоматическое подтверждение по обращениям ещё не принято.
- Реальная utility compaction после исправления сравнения JSONB сохраняет ровно `Саша → Шурик → Саша → Шурик`. Новый builder читает последнее обращение после boundary. Контрольные запросы compaction заняли 3829 и 3800 мс.
- Нативный TEI-запрос из pod завершился за 147 мс при штатном 2-секундном timeout. В полном локальном smoke timeout транспорта установлен в 20 секунд, потому что добавлен `kubectl exec`; latency этого bridge не доказывает штатный 2-секундный budget приложения.

Итоговый запуск сохранённого `live-analysis-smoke.mjs` завершился **exit code 2**: факт сохранён, self evidence 0.95, retry не усилил его, incoming source 62 получил support 0.83 / addressing 0.88, owner applied, отрицательный пример отвергнут с support 0.10, compaction и restart assertions прошли. Первый анализ: window 40 мс, extraction 5616 мс, verification 1784 мс, embedding bridge 961 мс; полная попытка около 8.9 секунды. Лог текущей машины: `/private/tmp/phoronis-analysis-live-retained.log`. Полный live gate остаётся открытым.

Воспроизводимые fixtures сохранены рядом: `fixtures/live-analysis-smoke.mjs` и `fixtures/live-compaction-smoke.mjs`. Они требуют явную изолированную БД и pod; полный fixture возвращает exit code 2, если независимое evidence не довело alias до CONFIRMED. Другие assertions возвращают 1. Не интерпретировать exit code 2 как успешную полную приёмку.

```sh
RUN_ANALYSIS_DB_TESTS=1 \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55435/phoronis_alias_test \
PHORONIS_SMOKE_POD=<актуальный-pod> \
PHORONIS_SMOKE_KUBECONFIG=<путь-к-kubeconfig> \
rtk proxy bun openspec/changes/repair-user-analysis-and-alias-context/fixtures/live-analysis-smoke.mjs
```

Для отдельной compaction заменить имя fixture на `live-compaction-smoke.mjs`. Перед повтором создать такую же отдельную БД и применить существующие миграции. Для fixture требуется доступ к реальным providers; секреты в файлы и аргументы не передаются.

## Повтор с policy v2, 5 октября 2026 года

По явному запросу пользователя принятие Jev снижено до `0.8` включительно (факты, отношения, принадлежность alias, пригодность обращения); отклонение осталось `<= 0.1`. Версия политики — 2, исторические решения не переписаны. Два независимых автора и накопленный рейтинг `>= 0.9` для автоматического обращения сохранены.

`live-analysis-smoke.mjs` повторён той же командой выше и завершился **exit code 0**. Self evidence 0.95 сохранило alias как CANDIDATE; incoming source 62 с support **0.81** / addressing **0.88** добавил второго автора: **CONFIRMED**, evidenceCount 2, authorCount 2, confidence **0.960125**. Retry сохранил evidenceCount 1 до второго окна. Owner-команда выбрала Саша; отрицательный пример получил 0.09 и был отвергнут; четыре snapshots и restart assertions прошли. Лог: `/private/tmp/phoronis-analysis-live-policy-v2.log`. Первый extraction запрос — 14.4 секунды, всё ещё внутри установленного budget.

Граничные regression tests проверяют incoming evidence и факты: `0.8` и `0.83` принимаются, `0.799` не записывается; audit содержит policyVersion 2 и фактические пороги. Итог: typecheck, scoped Biome, 73 Vitest suites / 390 tests и strict OpenSpec PASS. Отдельная SQL-приёмка не заменяет ещё отсутствующий реальный сценарий прерывания после частичного сохранения и quota deferral.

## Открытая приёмка

- **1.4:** исходная причина production `The operation timed out.` не локализована. Новый bounded synthetic flow работает, но прежняя ошибка не содержит stage. Model change и новые budgets сами по себе не доказывают исправление старой причины.
- **7.2 выполнен в релизном checkout:** полный реальный smoke с utility/Jev и изолированной БД дополнен падением worker после сохранения до COMPLETED. После истечения lease новый worker сохранил original createdAt/окно, получил quota_deferred без provider calls и условно вернул PENDING без расхода error-attempt. После восстановления квоты retry сохранил число фактов/evidence; второе evidence подтвердило alias (2 автора, confidence 0.9681). Отрицательный пример, owner и compaction/restart прошли. Лог: `/private/tmp/phoronis-release-live.log`, exit code 0.
- **7.3:** необходим отдельный запрос на deployment и ограниченное production-восстановление. До него нельзя подтвердить image/health нового worker, исходную timeout-причину или восстановленные aliases конкретного пользователя. Runbook dry-run → одно окно → evidence/quota/stage latency находится в README.

Change не архивирован. Локально реализованные и проверенные пункты отмечены отдельно от этих трёх gates.

## Подготовка релиза

По запросу пользователя на commit/push/deployment создан отдельный checkout от origin/master 4837f80. Telemetry-файлы из master сохранены без отката; основной dirty checkout не сбрасывался. В релиз включены необходимые подготовленные model/Jev изменения и DecisionReview-миграция. Интеграционный fixture теперь контролирует Jev вместо использования credentials; найденная форма Сашей сопоставляется с сохранённой Саша без зависимости от модели.
