# Tasks

## 1. Транспорт и журнал

- [x] 1.1 Добавить RouterAI decisions client с фиксированной Jev, timeout/abort и runtime-валидацией; проверить unit-тестами корректный ответ, missing answers, неизвестный choice, неверные вероятности и HTTP/timeout ошибки.
- [x] 1.2 Добавить DecisionReview, добавочную миграцию, репозиторий и безопасные JSON-события; проверить на изолированной БД сохранение кандидата, cascade удаления источника/пользователя, ограничение срока, non-fatal ошибку журнала и отсутствие текста в stdout.

## 2. Факты и псевдонимы

- [x] 2.1 Встроить пакетную проверку поддержки фактов по исходному сообщению после ID/author/privacy guards; проверить тестами accepted/rejected/uncertain/error, выбор text вместо summary и отсутствие непроверенных записей.
- [x] 2.2 Заменить LLM-сравнение фактов Jev Choice; проверить duplicate/contradiction/independent/unclear, low probability, неизменность evidence idempotency и журнал фактического действия.
- [x] 2.3 Проверять принадлежность и пригодность aliases отдельно и использовать identity probability в evidence; проверить third-person reply, unsuitable addressing, отсутствие private/bot sources и сохранение owner overrides/агрегирования.

## 3. Последующий разбор

- [x] 3.1 Добавить почасовую очистку с отдельным lock и операторский отчёт `jev:report` за период с фильтром чата/JSON/ограниченной выборкой; проверить параметры, пустой период, агрегаты, истечение срока и scheduler lifecycle тестами, описать команды и ограничения в README.

## 4. Интеграционная проверка

- [x] 4.1 Запустить typecheck, lint, полный unit suite, PostgreSQL-проверку миграции/журнала/отчёта и strict OpenSpec validation; сохранить результаты и отделить baseline failures.
- [ ] 4.2 Выполнить синтетический live RouterAI smoke для фактов, отношений и aliases, если credentials доступны, и записать версии/решения/latency без секретов; при недоступности провайдера явно оставить этот пункт незавершённым.

Результаты: [validation.md](validation.md). Пункт 4.2 открыт: `ROUTERAI_API_KEY` отсутствует в окружении локальной проверки; реальная точность/latency Jev не проверены. Выкатка и миграция рабочей БД не выполнялись.
