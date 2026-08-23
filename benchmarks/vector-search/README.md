# Benchmark vector search

Этот benchmark проверяет exact pgvector queries до любого решения об ANN-индексе.

Reference environment:

- образ PostgreSQL/pgvector: `pgvector/pgvector:0.8.2-pg18-trixie`;
- выделенные ресурсы: 2 CPU и 2 GiB RAM;
- session settings: `max_parallel_workers_per_gather=0`, `work_mem=64MB`, `random_page_cost=1.1`;
- deterministic seed по умолчанию: `424242`;
- минимум `max(2 × production cardinality, 100000)` synthetic rows для каждого профиля.

Запуск выполняется на отдельной test database с применёнными Prisma migrations:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/phoronis_benchmark \
  bun run db:benchmark:vector
```

Скрипт читает из основной схемы только агрегированную cardinality, использует временные таблицы и откатывает транзакцию. Пользовательские тексты, идентификаторы и embeddings в evidence не попадают. Для повторной проверки запустите команду дважды на той же чистой test database или на новом экземпляре.

Evidence сохраняется в `openspec/changes/harden-runtime-delivery-and-search/evidence/vector-search-baseline.json` и содержит дату, версии PostgreSQL/pgvector, настройки, cardinality, размер seed-набора, p50/p95 и `EXPLAIN (ANALYZE, BUFFERS)` для message и user-fact queries.

Если exact p95 не превышает 100 мс, ANN migration не добавляется. Если budget превышен, индекс разрешается только после отдельной проверки filter correctness и recall@k не ниже 0,95.
