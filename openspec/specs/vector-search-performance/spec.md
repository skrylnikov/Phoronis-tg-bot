# vector-search-performance Specification

## Purpose

Задаёт измеримый performance contract для pgvector-поиска и разрешает ANN-индекс только после воспроизводимого доказательства необходимости.

## Requirements

### Requirement: Vector search имеет воспроизводимый benchmark

Система MUST иметь воспроизводимый benchmark основных message и user-fact vector queries. Профиль MUST документировать схему, размер набора не меньше удвоенной текущей production cardinality или 100 000 eligible rows (что больше), распределение фильтров, число запросов, p50/p95 latency и `EXPLAIN (ANALYZE, BUFFERS)`.

#### Scenario: Зафиксирован baseline точного поиска

- **WHEN** benchmark запускается на документированном reference environment
- **THEN** результат содержит cardinality, параметры PostgreSQL/pgvector, планы запросов, p50/p95 и дату измерения

#### Scenario: Набор меньше production profile

- **WHEN** benchmark не достигает требуемой cardinality или не воспроизводит обязательные фильтры
- **THEN** его результат не используется для решения о добавлении или отказе от ANN-индекса

### Requirement: Индекс вводится только при превышении performance budget

Точная vector query MUST сохраняться без ANN-индекса, пока её database p95 не превышает 100 мс на целевом benchmark-профиле. Если budget превышен, система MUST добавить минимально достаточный pgvector-индекс, повторно измерить latency и проверить корректность обязательных фильтров и recall относительно exact baseline.

#### Scenario: Точный поиск укладывается в budget

- **WHEN** p95 всех обязательных vector queries не превышает 100 мс
- **THEN** change не добавляет ANN-индекс и сохраняет baseline как evidence

#### Scenario: Точный поиск превышает budget

- **WHEN** хотя бы одна обязательная vector query устойчиво превышает p95 100 мс
- **THEN** система добавляет индекс только для подтверждённого запроса и показывает повторное измерение ниже budget либо документированное ограничение

#### Scenario: ANN ухудшает корректность

- **WHEN** индексированный поиск нарушает обязательные chat/user/privacy filters или его recall@k ниже 0,95 относительно exact baseline
- **THEN** индекс не включается в production path
