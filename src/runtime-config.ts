function showError(message: string): never {
  throw new Error(message);
}

function positiveIntegerEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = Number(env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    showError(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

export function readQueueConfig(env: Record<string, string | undefined>) {
  return {
    normalWorkers: positiveIntegerEnv(env, 'QUEUE_NORMAL_WORKERS', 3, 32),
    leaseDurationMs: positiveIntegerEnv(
      env,
      'QUEUE_LEASE_DURATION_MS',
      5 * 60 * 1000,
    ),
    pollIntervalMs: positiveIntegerEnv(env, 'QUEUE_POLL_INTERVAL_MS', 250),
    maxAttempts: positiveIntegerEnv(env, 'QUEUE_MAX_ATTEMPTS', 5, 100),
  };
}

export function readJobConfig(env: Record<string, string | undefined>) {
  return {
    workers: positiveIntegerEnv(env, 'JOB_WORKERS', 1, 32),
    leaseDurationMs: positiveIntegerEnv(
      env,
      'JOB_LEASE_DURATION_MS',
      5 * 60 * 1000,
    ),
    pollIntervalMs: positiveIntegerEnv(env, 'JOB_POLL_INTERVAL_MS', 500),
    maxAttempts: positiveIntegerEnv(env, 'JOB_MAX_ATTEMPTS', 5, 100),
  };
}

export function readRuntimeConfig(env: Record<string, string | undefined>) {
  const databaseURL =
    env.DATABASE_URL ?? showError('DATABASE_URL not found in .env');
  let parsed: URL;
  try {
    parsed = new URL(databaseURL);
  } catch {
    showError('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    showError('DATABASE_URL must be a PostgreSQL URL');
  }

  return {
    databaseURL,
    queue: readQueueConfig(env),
    job: readJobConfig(env),
    shutdownDrainMs: positiveIntegerEnv(
      env,
      'SHUTDOWN_DRAIN_MS',
      30_000,
      10 * 60 * 1000,
    ),
  };
}
