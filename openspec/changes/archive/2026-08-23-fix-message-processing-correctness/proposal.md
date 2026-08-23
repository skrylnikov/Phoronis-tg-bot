## Why

Три пользовательских потока нарушают уже заявленные контракты: DB fallback не находит корневое фото в multi-hop reply chain, неуспешный анализ сообщений списывает квоту без retry, а ответ в private mode сохраняется как обычное публичное сообщение. Эти дефекты затрагивают распознавание, платные лимиты и приватность данных.

## What Changes

- Исправить обход reply chain так, чтобы текущая запись из БД проверялась на фото до решения завершить цепочку из-за отсутствующего родителя.
- Добавить автоматические сценарии для 2-hop/3-hop DB fallback, корневого фото без родителя и ограничения `maxDepth`.
- Сделать неуспех fact analysis наблюдаемой ошибкой: durable job должен перейти в retry/terminal failure, а зарезервированная `ANALYSIS`-квота должна возвращаться до успешного результата.
- Сохранять ответы бота в private mode с тем же private-признаком, чтобы они не попадали в embeddings/history и удалялись вместе с приватным диалогом.
- Добавить regression-тесты для всех трёх потоков без общей перестройки message pipeline.

## Capabilities

### New Capabilities

- `private-message-retention`: единая приватность, исключение из контекста и срок хранения обеих сторон private-mode диалога.

### Modified Capabilities

- `image-recognition`: уточнить DB fallback для корневого фото и обязательное покрытие multi-hop сценариев.
- `quota-limits`: уточнить возврат `ANALYSIS`-квоты и retry при неуспешном фоновом анализе.

## Impact

- Затронуты `src/controllers/process-message.ts`, AI response persistence, user-analysis orchestration и fact analyzer error propagation.
- Возможны изменения в сигнатуре результата fact analysis, но публичные Telegram-команды и схема БД не меняются.
- Существующие private bot responses не мигрируются и не удаляются этим change; исправляется поведение новых сообщений.
