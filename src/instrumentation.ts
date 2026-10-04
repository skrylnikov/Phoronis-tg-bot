import { configureGlobalLogger } from '@langfuse/core';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { sanitizeTraceData } from './ai/trace-data';
import { AiTraceProcessor } from './ai/trace-processor';
import { langfuseConfig } from './config';
import { logger } from './logger';

// Disable SDK debug dumps, including constructor configuration and span bodies.
configureGlobalLogger({ level: 2 });

let nodeSdk: NodeSDK | undefined;

let started = false;

export function startTelemetry(): void {
  if (started) return;
  try {
    nodeSdk = new NodeSDK({
      spanProcessors: [
        new AiTraceProcessor({
          mediaUploadEnabled: false,
          mask: ({ data }) => sanitizeTraceData(data),
          publicKey: langfuseConfig.publicKey,
          secretKey: langfuseConfig.secretKey,
          baseUrl: langfuseConfig.baseUrl,
          environment: langfuseConfig.environment,
        }),
      ],
    });
    nodeSdk.start();
    started = true;
  } catch {
    logger.warn(
      { event: 'telemetry.start_failed' },
      'Telemetry initialization failed',
    );
  }
}

export function shutdownTelemetry(): Promise<void> {
  if (!started) return Promise.resolve();
  started = false;
  return nodeSdk?.shutdown() ?? Promise.resolve();
}
