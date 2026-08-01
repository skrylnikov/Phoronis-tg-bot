import { logger } from '../logger';

type ErrorLogFields = Record<string, unknown>;

/**
 * Enhanced error handler with context information
 */
export function handleError(
  error: unknown,
  context: string,
  fields: ErrorLogFields = {},
): void {
  logger.error(
    { ...fields, event: fields.event ?? 'error.occurred', context, err: error },
    'Error occurred',
  );
}

/**
 * Type guard for Telegram errors
 */
export function isTelegramError(
  error: unknown,
): error is { description: string; code: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'description' in error &&
    'code' in error
  );
}
