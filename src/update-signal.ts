import { AsyncLocalStorage } from 'node:async_hooks';

const updateSignals = new AsyncLocalStorage<AbortSignal>();

export function withUpdateAbortSignal<T>(
  signal: AbortSignal,
  callback: () => Promise<T>,
): Promise<T> {
  return updateSignals.run(signal, callback);
}

export function currentUpdateAbortSignal(): AbortSignal | undefined {
  return updateSignals.getStore();
}

export function currentUpdateAbortSignalWithTimeout(
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const updateSignal = currentUpdateAbortSignal();
  return updateSignal
    ? AbortSignal.any([updateSignal, timeoutSignal])
    : timeoutSignal;
}

export function throwIfUpdateAborted(): void {
  const signal = currentUpdateAbortSignal();
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Telegram update processing aborted');
  }
}
