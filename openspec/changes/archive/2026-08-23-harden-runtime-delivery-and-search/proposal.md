## Why

После основного архитектурного hardening остаются три риска второго приоритета: внешняя доставка payment notification имеет неизбежное crash window, polling transport объявляется готовым до фактического старта, а vector search не имеет измеримого порога масштабирования. Их следует зафиксировать честными контрактами и минимальными проверяемыми механизмами, не вводя speculative infrastructure.

## What Changes

- Разделить backend-дедупликацию payment jobs и семантику внешней Telegram-доставки: гарантировать одну durable job и at-least-once delivery, сохранять доставленный `message_id`, наблюдать редкое crash-window повторение и не обещать недостижимый exactly-once Bot API.
- Исправить polling lifecycle: readiness выставляется только после подтверждённого старта, ошибка запуска делает transport неготовым и приводит к управляемому завершению/повторному запуску согласно выбранному lifecycle.
- Добавить воспроизводимый benchmark и telemetry gate для vector search; создавать HNSW/другой индекс только если измерения на целевом объёме показывают превышение согласованного latency/scan порога.
- Добавить проверки доставки, polling startup failure и плана выполнения vector queries.

## Capabilities

### New Capabilities

- `vector-search-performance`: измеримый performance contract и условие введения ANN-индекса для pgvector.

### Modified Capabilities

- `payment-notification-delivery`: заменить недостижимое обещание внешней exactly-once доставки на точный durable/at-least-once контракт с наблюдаемым crash window.
- `runtime-readiness`: readiness polling transport должна отражать фактический успешный запуск и сбрасываться при ошибке.

## Impact

- Затронуты background job/payment delivery metadata, polling transport lifecycle, readiness-тесты и pgvector benchmark/migration при подтверждённой необходимости.
- Может потребоваться additive Prisma migration для хранения Telegram `message_id`/delivery metadata; удаление или переписывание job history не требуется.
- Производственный webhook transport и текущие тарифы не меняются.
