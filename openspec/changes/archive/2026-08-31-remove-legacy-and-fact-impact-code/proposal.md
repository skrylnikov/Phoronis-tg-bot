## Why

В приложении остались неработающий контур оценки пользовательских фактов по реакциям, завершённые runtime-миграции и неиспользуемые модули. Они усложняют scheduler, схему PostgreSQL и аналитику, при этом создают недостоверный показатель «использовано фактов» и не дают продуктовой ценности.

## What Changes

- **BREAKING** Удалить обработку реакций на ответы бота, `FactImpact`, пересчёт `impactScore` и связанные поля ранжирования фактов; базовое ранжирование продолжит использовать актуальные `weight`, `confidence`, тип и свежесть.
- **BREAKING** Убрать из дневной аналитики недостоверный показатель использованных фактов, сохранив количество новых фактов и остальные метрики.
- После подтверждения сходимости удалить runtime-миграцию `User.metaInfo`, сам legacy JSON и дублирующие одиночные поля источника `UserFact`; `UserFactEvidence` останется единственным источником provenance.
- Удалить пустую команду `/index`, неиспользуемые language/analysis-модули, мёртвые barrel-файлы и экспорты без вызывающего кода.
- Сохранить существующую историю Prisma migrations, embedding backfill, совместимый импорт старой истории AI-тредов и fallback доставки Telegram.
- Разделить удаление runtime-зависимостей и физический `DROP` схемы на два проверяемых релиза, чтобы migration init-container не ломал ещё работающий старый pod.

## Capabilities

### New Capabilities

- Нет.

### Modified Capabilities

- `daily-analytics`: отчёт перестаёт публиковать недостоверный счётчик использованных фактов.
- `scheduled-maintenance`: fact-impact recalculation и завершённая `metaInfo` migration перестают быть плановыми задачами.
- `ai-context-and-prompts`: исторический `User.metaInfo` больше не является поддерживаемым runtime- или migration-путём после подтверждённой сходимости.

## Impact

- Код: controllers обработки сообщений и feature-команд, scheduler/advisory locks, fact domain/repositories, analytics, конфигурация и связанные тесты.
- Данные: удаляются `FactImpact`, `User.metaInfo`, `UserFact.usageCount`, `lastUsedAt`, `impactScore`, legacy source columns и их индексы/relations; исторические impact-данные намеренно не переносятся.
- Спецификации: меняются `daily-analytics`, `scheduled-maintenance` и `ai-context-and-prompts`.
- Эксплуатация: нужны preflight-проверки данных и два последовательных rollout; старые каталоги Prisma migrations не переписываются и не удаляются.
