export type RuntimeComponent =
  | 'database'
  | 'embeddings'
  | 'transport'
  | 'updateWorkers'
  | 'jobWorker';

export type RuntimeComponentState = 'ready' | 'not-ready';

const requiredComponents: RuntimeComponent[] = [
  'database',
  'embeddings',
  'transport',
  'updateWorkers',
  'jobWorker',
];

export class RuntimeState {
  private readonly components = new Map<
    RuntimeComponent,
    RuntimeComponentState
  >();
  private shuttingDown = false;

  constructor() {
    for (const component of requiredComponents) {
      this.components.set(component, 'not-ready');
    }
  }

  setReady(component: RuntimeComponent, ready: boolean): void {
    const previous = this.components.get(component);
    this.components.set(component, ready ? 'ready' : 'not-ready');
    if (previous !== (ready ? 'ready' : 'not-ready')) {
      logger.info(
        {
          event: 'runtime.component_state_changed',
          component,
          status: ready ? 'ready' : 'not-ready',
        },
        'Runtime component state changed',
      );
    }
  }

  beginShutdown(): void {
    logger.info(
      { event: 'runtime.shutdown_started' },
      'Runtime shutdown started',
    );
    this.shuttingDown = true;
    for (const component of requiredComponents) {
      this.components.set(component, 'not-ready');
    }
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  isReady(): boolean {
    return (
      !this.shuttingDown &&
      requiredComponents.every(
        (component) => this.components.get(component) === 'ready',
      )
    );
  }

  snapshot(): Record<RuntimeComponent, RuntimeComponentState> {
    return Object.fromEntries(
      requiredComponents.map((component) => [
        component,
        this.components.get(component),
      ]),
    ) as Record<RuntimeComponent, RuntimeComponentState>;
  }
}

export const runtimeState = new RuntimeState();

import { logger } from './logger';
