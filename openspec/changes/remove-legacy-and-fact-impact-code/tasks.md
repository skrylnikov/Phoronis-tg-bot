## 1. Зафиксировать границы и data gates

- [x] 1.1 Повторно проверить dirty worktree и все ссылки на fact-impact, `metaInfo`, legacy source-поля и кандидаты dead code; сохранить несвязанные hardening-изменения и подтвердить scope repository-wide поиском.
- [x] 1.2 На целевой БД read-only запросами подтвердить наличие `UserFactEvidence`, отсутствие непустого `User.metaInfo` и отсутствие legacy source-пар без соответствующей evidence-записи; сохранить только агрегированные counts без пользовательских данных.
- [x] 1.3 Если `metaInfo` или evidence gaps ненулевые, довести существующую идемпотентную миграцию/backfill до сходимости и повторить read-only проверки; не начинать удаление runtime-пути до нулевого результата.

## 2. Совместимый cleanup-релиз без DROP

- [x] 2.1 Удалить обработку реакций из message controller и весь fact-impact domain/repository API, включая мёртвые `trackFactUsage` и stats helpers; focused-тесты подтверждают, что обычные text/image replies продолжают обрабатываться без reaction side effects.
- [x] 2.2 Удалить fact-impact scheduler task, отдельный lock key и связанные ожидания lifecycle-тестов; scheduler-тест подтверждает запуск, взаимное исключение и остановку оставшихся задач.
- [x] 2.3 Удалить `impactScore` из формулы ранжирования и неиспользуемые usage/score repository helpers, сохранив порядок по `weight`, `confidence`, типу, сроку действия и свежести; focused-тест фиксирует новое ранжирование.
- [x] 2.4 Удалить запрос и строку «Использовано фактов» из дневной аналитики, сохранив «Новых фактов» и остальные показатели; analytics-тест проверяет итоговый русский отчёт.
- [x] 2.5 Удалить запуск/остановку runtime-миграции `User.metaInfo`, её domain/repository код и тесты после успешного data gate; repository-wide поиск подтверждает отсутствие runtime-чтений `metaInfo`.
- [x] 2.6 Перестать записывать legacy `UserFact.sourceChatId/sourceMessageId`, сохранив создание и обновление `UserFactEvidence`; unit и PostgreSQL integration tests подтверждают provenance и current-chat filtering.
- [x] 2.7 Удалить пустую `/index`, `domain/language`, `analysis-limiter`, мёртвый `domain/user` barrel, связанные константы и подтверждённые leaf-экспорты без callers; repository-wide поиск и typecheck подтверждают отсутствие потерянных entrypoints.
- [x] 2.8 Обновить unit/integration tests после удаления подсистемы и выполнить `bun run typecheck`, `bun run lint`, `bun run test` и безопасный PostgreSQL integration suite без изменения Prisma schema первого релиза.
- [ ] 2.9 При отдельном разрешении выкатить совместимый cleanup-релиз и подтвердить новый image/digest, завершённый rollout всех pod, `/healthz` и `/readyz`, отсутствие schema/fact-impact/meta-migration ошибок и отсутствие строки «Использовано фактов» в ручной аналитике.

## 3. Destructive schema cleanup после rollout

- [ ] 3.1 После полного rollout cleanup-релиза повторить data gates и подтвердить, что ни один работающий pod не читает и не пишет удаляемые объекты; без этого не создавать destructive migration.
- [ ] 3.2 Добавить новую forward Prisma migration, удаляющую `FactImpact`, `UserFact.usageCount`, `lastUsedAt`, `impactScore`, legacy source columns и `User.metaInfo` вместе с их FK/index/relation; старые migration-файлы оставить неизменными и проверить SQL на production-like snapshot.
- [ ] 3.3 Обновить `schema.prisma`, regenerate Prisma client и удалить оставшиеся generated references; `prisma validate` и `bun run typecheck` подтверждают соответствие финальной схеме.
- [ ] 3.4 Проверить полный migration path на пустой безопасной PostgreSQL БД и upgrade path на production-like snapshot; оба `prisma migrate deploy` завершаются без pending/failed migrations и финальная схема не содержит удалённых объектов.
- [ ] 3.5 Выполнить `bun run lint`, `bun run test` и безопасный PostgreSQL integration suite на финальной схеме; тесты фактов, аналитики, scheduler и runtime lifecycle проходят без legacy mocks.
- [ ] 3.6 При отдельном разрешении выкатить schema-cleanup релиз и подтвердить migration init-container, новый image/digest, rollout, readiness, AI-ответ с фактами, дневную аналитику и свежие логи без обращений к удалённой схеме.

## 4. Проверка OpenSpec и остаточного legacy-кода

- [ ] 4.1 Выполнить `openspec validate "remove-legacy-and-fact-impact-code" --strict` и `openspec validate --specs`; обе проверки проходят без ошибок.
- [ ] 4.2 Повторить repository-wide поиск по `FactImpact`, `impactScore`, `usageCount`, `lastUsedAt`, `metaInfo`, legacy source relations, `/index`, `analysis-limiter` и `domain/language`; оставшиеся совпадения относятся только к неизменяемой migration/OpenSpec history или явно сохранённым compatibility-paths.
