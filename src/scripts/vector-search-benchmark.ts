import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';

const MIN_ROWS = 100_000;
const DEFAULT_SEED = 42_4242;
const DEFAULT_SAMPLES = 50;
const DEFAULT_OUTPUT =
  'openspec/changes/harden-runtime-delivery-and-search/evidence/vector-search-baseline.json';
const REFERENCE_IMAGE = 'pgvector/pgvector:0.8.2-pg18-trixie';
const REFERENCE_CPUS = 2;
const REFERENCE_MEMORY = '2g';

interface Cardinality {
  message: number;
  userFact: number;
}

interface QueryProfile {
  name: string;
  sql: string;
  params: [number, number];
}

interface QueryResult {
  name: string;
  warmup: number;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  explain: unknown;
}

interface AnnValidation {
  name: string;
  indexName: string;
  recallAt8: number;
  filtersCorrect: boolean;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value || fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('Benchmark numeric options must be positive integers');
  }
  return parsed;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1,
  );
  return Number(sorted[index].toFixed(3));
}

async function explain(
  client: Client,
  profile: QueryProfile,
): Promise<unknown> {
  const result = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${profile.sql}`,
    profile.params,
  );
  return result.rows[0]?.['QUERY PLAN'] ?? null;
}

async function queryIds(
  client: Client,
  profile: QueryProfile,
): Promise<number[]> {
  const result = await client.query<{ id: string }>(
    profile.sql,
    profile.params,
  );
  return result.rows.map((row) => Number(row.id));
}

async function validateFilters(
  client: Client,
  profile: QueryProfile,
  ids: number[],
): Promise<boolean> {
  if (ids.length === 0) return true;
  const filter =
    profile.name === 'message-by-chat'
      ? `
          chat_id = $2
          AND private IS NOT TRUE
          AND embedding_version = 1
          AND search_text IS NOT NULL
        `
      : `user_id = $2 AND embedding_version = 1 AND type = 'FACT'`;
  const table =
    profile.name === 'message-by-chat'
      ? 'vector_benchmark_message'
      : 'vector_benchmark_user_fact';
  const result = await client.query<{ count: string }>(
    `SELECT count(*) FROM ${table} WHERE id = ANY($1::bigint[]) AND ${filter}`,
    [ids, profile.params[0]],
  );
  return Number(result.rows[0]?.count || 0) === ids.length;
}

async function measure(
  client: Client,
  profile: QueryProfile,
  warmup: number,
  samples: number,
): Promise<QueryResult> {
  for (let index = 0; index < warmup; index += 1) {
    await client.query(profile.sql, profile.params);
  }

  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    await client.query(profile.sql, profile.params);
    durations.push(performance.now() - startedAt);
  }

  return {
    name: profile.name,
    warmup,
    samples,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    explain: await explain(client, profile),
  };
}

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error('DATABASE_URL is required');

const seed = positiveInteger(process.env.VECTOR_BENCHMARK_SEED, DEFAULT_SEED);
const samples = positiveInteger(
  process.env.VECTOR_BENCHMARK_SAMPLES,
  DEFAULT_SAMPLES,
);
const warmup = positiveInteger(process.env.VECTOR_BENCHMARK_WARMUP, 10);
const outputPath = process.env.VECTOR_BENCHMARK_OUTPUT || DEFAULT_OUTPUT;
const client = new Client({ connectionString: databaseURL });

await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SET LOCAL max_parallel_workers_per_gather = 0');
  await client.query("SET LOCAL work_mem = '64MB'");
  await client.query('SET LOCAL random_page_cost = 1.1');

  const extension = await client.query<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
  );
  if (!extension.rows[0]) {
    throw new Error('PostgreSQL vector extension is required');
  }

  const cardinalityResult = await client.query<{
    message: string;
    user_fact: string;
  }>(`
    SELECT
      (SELECT count(*)
       FROM "Message"
       WHERE "private" IS NOT TRUE
         AND "embeddingVersion" = 1
         AND "embedding" IS NOT NULL
         AND "searchText" IS NOT NULL) AS message,
      (SELECT count(*)
       FROM "UserFact"
       WHERE "embeddingVersion" = 1
         AND "embedding" IS NOT NULL) AS user_fact
  `);
  const cardinality: Cardinality = {
    message: Number(cardinalityResult.rows[0]?.message || 0),
    userFact: Number(cardinalityResult.rows[0]?.user_fact || 0),
  };
  const targetRows = {
    message: Math.max(MIN_ROWS, cardinality.message * 2),
    userFact: Math.max(MIN_ROWS, cardinality.userFact * 2),
  };
  const queryScalar = ((seed + 42) % 1000) / 1000;

  await client.query(`
    CREATE TEMP TABLE vector_benchmark_message (
      id bigint NOT NULL,
      chat_id bigint NOT NULL,
      sender_id bigint NOT NULL,
      private boolean,
      embedding_version integer,
      search_text text,
      embedding vector(384) NOT NULL
    ) ON COMMIT DROP
  `);
  await client.query(`
    CREATE TEMP TABLE vector_benchmark_user_fact (
      id bigint NOT NULL,
      user_id bigint NOT NULL,
      type text NOT NULL,
      embedding_version integer,
      embedding vector(384) NOT NULL
    ) ON COMMIT DROP
  `);
  await client.query(
    `
      INSERT INTO vector_benchmark_message
        (id, chat_id, sender_id, private, embedding_version, search_text, embedding)
      SELECT
        row_id,
        -1000000 - ((row_id + $1) % 100),
        1000 + ((row_id + $1) % 1000),
        row_id % 19 = 0,
        CASE WHEN row_id % 7 = 0 THEN 2 ELSE 1 END,
        'synthetic benchmark message',
        array_prepend((($1 + row_id) % 1000)::real / 1000, array_fill(0::real, ARRAY[383]))::vector
      FROM generate_series(1, $2::integer) AS row_id
    `,
    [seed, targetRows.message],
  );
  await client.query(
    `
      INSERT INTO vector_benchmark_user_fact
        (id, user_id, type, embedding_version, embedding)
      SELECT
        row_id,
        1000 + ((row_id + $1) % 1000),
        CASE WHEN row_id % 4 = 0 THEN 'INTEREST' ELSE 'FACT' END,
        CASE WHEN row_id % 7 = 0 THEN 2 ELSE 1 END,
        array_prepend((($1 + row_id) % 1000)::real / 1000, array_fill(0::real, ARRAY[383]))::vector
      FROM generate_series(1, $2::integer) AS row_id
    `,
    [seed, targetRows.userFact],
  );
  await client.query('ANALYZE vector_benchmark_message');
  await client.query('ANALYZE vector_benchmark_user_fact');

  const profiles: QueryProfile[] = [
    {
      name: 'message-by-chat',
      sql: `
        SELECT id
        FROM vector_benchmark_message
        WHERE chat_id = $1
          AND private IS NOT TRUE
          AND embedding_version = 1
          AND embedding IS NOT NULL
          AND search_text IS NOT NULL
        ORDER BY embedding <=> array_prepend($2::real, array_fill(0::real, ARRAY[383]))::vector
        LIMIT 8
      `,
      params: [-1000000 - ((42 + seed) % 100), queryScalar],
    },
    {
      name: 'user-fact-by-user-and-type',
      sql: `
        SELECT id
        FROM vector_benchmark_user_fact
        WHERE user_id = $1
          AND embedding_version = 1
          AND embedding IS NOT NULL
          AND type = 'FACT'
        ORDER BY embedding <=> array_prepend($2::real, array_fill(0::real, ARRAY[383]))::vector
        LIMIT 8
      `,
      params: [1000 + ((42 + seed) % 1000), queryScalar],
    },
  ];
  const results = await Promise.all(
    profiles.map((profile) => measure(client, profile, warmup, samples)),
  );
  const p95 = Math.max(...results.map((result) => result.p95Ms));
  const exactIds = new Map(
    await Promise.all(
      profiles.map(
        async (profile) =>
          [profile.name, await queryIds(client, profile)] as const,
      ),
    ),
  );
  const annProfiles = profiles.filter(
    (_profile, index) => results[index].p95Ms > 100,
  );
  const annIndexNames = new Map<string, string>();
  for (const profile of annProfiles) {
    const table =
      profile.name === 'message-by-chat'
        ? 'vector_benchmark_message'
        : 'vector_benchmark_user_fact';
    const indexName = `${table}_embedding_hnsw_idx`;
    await client.query(
      `CREATE INDEX ${indexName} ON ${table} USING hnsw (embedding vector_cosine_ops)`,
    );
    annIndexNames.set(profile.name, indexName);
  }
  const annResults = await Promise.all(
    annProfiles.map((profile) => measure(client, profile, warmup, samples)),
  );
  const annValidation: AnnValidation[] = [];
  for (const profile of annProfiles) {
    const approximateIds = await queryIds(client, profile);
    const baselineIds = exactIds.get(profile.name) || [];
    const baselineSet = new Set(baselineIds);
    const overlap = approximateIds.filter((id) => baselineSet.has(id)).length;
    annValidation.push({
      name: profile.name,
      indexName: annIndexNames.get(profile.name) || 'unknown',
      recallAt8: baselineIds.length
        ? Number((overlap / baselineIds.length).toFixed(3))
        : 1,
      filtersCorrect: await validateFilters(client, profile, approximateIds),
    });
  }
  const annP95 = annResults.length
    ? Math.max(...annResults.map((result) => result.p95Ms))
    : null;
  const annCorrect = annValidation.every(
    (result) => result.recallAt8 >= 0.95 && result.filtersCorrect,
  );
  const annLatencyWithinBudget = annP95 !== null && annP95 <= 100;
  const evidence = {
    measuredAt: new Date().toISOString(),
    referenceEnvironment: {
      image: REFERENCE_IMAGE,
      cpus: REFERENCE_CPUS,
      memory: REFERENCE_MEMORY,
      pgvectorVersion: extension.rows[0].extversion,
      postgres: (await client.query('SELECT version()')).rows[0]?.version,
      settings: {
        maxParallelWorkersPerGather: 0,
        workMem: '64MB',
        randomPageCost: 1.1,
      },
    },
    seed,
    productionCardinality: cardinality,
    targetRows,
    profiles: results,
    annProfiles: annResults,
    annValidation,
    decision: {
      exactP95BudgetMs: 100,
      maxExactP95Ms: p95,
      annMigrationRequired: p95 > 100,
      annMigrationApproved: p95 > 100 && annLatencyWithinBudget && annCorrect,
      annP95Ms: annP95,
      reason:
        p95 > 100
          ? annLatencyWithinBudget && annCorrect
            ? 'Exact p95 превышает 100 мс, но candidate ANN проходит latency, filter correctness и recall gate.'
            : 'Exact p95 превышает 100 мс, но candidate ANN не доказал безопасное включение production path.'
          : 'Exact p95 укладывается в 100 мс; production path остаётся без ANN-индекса.',
    },
  };

  await mkdir(outputPath.split('/').slice(0, -1).join('/') || '.', {
    recursive: true,
  });
  await writeFile(`${outputPath}`, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await client.query('ROLLBACK').catch(() => undefined);
  await client.end();
}
