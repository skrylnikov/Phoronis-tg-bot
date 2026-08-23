## 1. Reply-chain image recognition

- [x] 1.1 Добавить regression-тесты для 2-hop/3-hop DB fallback, корневого DB-фото без родителя и остановки на `maxDepth`; проверить focused process-message test
- [x] 1.2 Переставить проверку `media`/`summary` текущей DB-записи до проверки `replyToMessageId`, сохранив существующий bounded traversal; проверить тесты из 1.1

## 2. Надёжность ANALYSIS-квоты

- [x] 2.1 Добавить тест, где fact analyzer падает после резервирования ANALYSIS: job должна перейти в retry, а квота вернуться; проверить focused user-message-analysis test
- [x] 2.2 Заменить успешный `null` при ошибке fact analysis на логирование и проброс ошибки до durable runner; проверить временную и terminal failure ветки тестами
- [x] 2.3 Сделать сохранение факта идемпотентным для того же source message при retry после частичного успеха; проверить тестом, что вес факта не увеличивается повторно
- [x] 2.4 Проверить успешную повторную попытку: job завершается, результат сохранён, ANALYSIS-квота списана один раз; выполнить focused background-job test

## 3. Private response persistence

- [x] 3.1 Добавить regression-тесты для private bot response в text, photo и voice flows; проверить, что вход и ответ сохраняются с private-признаком
- [x] 3.2 Передать private mode в общий путь persistence AI response без отдельных хранилищ; проверить тесты из 3.1
- [x] 3.3 Проверить репозиторными тестами, что private bot responses исключены из embeddings/retrieval/recent history и удаляются семидневной очисткой
- [x] 3.4 Зафиксировать тестом отсутствие автоматической миграции исторических неприватных bot responses

## 4. Общая проверка

- [x] 4.1 Выполнить `bun run test`, `bun run typecheck`, `bun run lint` и `git diff --check`; все команды должны завершиться успешно
