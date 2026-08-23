import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { langfuseConfig } from './config';

const nodeSdk = new NodeSDK({
  spanProcessors: [
    new LangfuseSpanProcessor({
      publicKey: langfuseConfig.publicKey,
      secretKey: langfuseConfig.secretKey,
      baseUrl: langfuseConfig.baseUrl,
      environment: langfuseConfig.environment,
    }),
  ],
});

let started = false;

export function startTelemetry(): void {
  if (started) return;
  nodeSdk.start();
  started = true;
}

export function shutdownTelemetry(): Promise<void> {
  if (!started) return Promise.resolve();
  started = false;
  return nodeSdk.shutdown();
}
