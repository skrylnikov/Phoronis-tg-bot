import { logger } from '../logger';

/**
 * Enhanced error handler with context information
 */
export function handleError(error: unknown, context: string): void {
  if (error instanceof Error) {
    logger.error(
      {
        error: error.message,
        stack: error.stack,
        context,
      },
      'Error occurred',
    );
  } else {
    logger.error({ context, error }, 'Unknown error occurred');
  }
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
