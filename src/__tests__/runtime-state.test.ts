import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({ logger: { info: vi.fn() } }));

import { RuntimeState } from '../runtime-state';

describe('runtime readiness state machine', () => {
  it('becomes ready only after every required component starts', () => {
    const state = new RuntimeState();
    expect(state.isReady()).toBe(false);

    for (const component of [
      'database',
      'embeddings',
      'transport',
      'updateWorkers',
      'jobWorker',
    ] as const) {
      state.setReady(component, true);
    }

    expect(state.isReady()).toBe(true);
  });

  it('invalidates readiness before shutdown', () => {
    const state = new RuntimeState();
    for (const component of [
      'database',
      'embeddings',
      'transport',
      'updateWorkers',
      'jobWorker',
    ] as const) {
      state.setReady(component, true);
    }

    state.beginShutdown();

    expect(state.isShuttingDown()).toBe(true);
    expect(state.isReady()).toBe(false);
    expect(state.snapshot()).toEqual({
      database: 'not-ready',
      embeddings: 'not-ready',
      transport: 'not-ready',
      updateWorkers: 'not-ready',
      jobWorker: 'not-ready',
    });
  });
});
