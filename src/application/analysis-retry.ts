import { parseArgs } from 'node:util';
export function parseAnalysisRetryArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      'chat-id': { type: 'string' },
      'user-id': { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      limit: { type: 'string', default: '10' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return { help: true as const };
  const id = (value: string | undefined, name: string, required = false) => {
    if (value === undefined && !required) return undefined;
    if (
      !value ||
      !/^-?\d+$/u.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      throw new Error(`Invalid --${name}`);
    return BigInt(value);
  };
  const date = (value: string | undefined, name: string) => {
    if (value === undefined) return undefined;
    if (
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
      !Number.isFinite(Date.parse(value))
    )
      throw new Error(`Invalid --${name}: use ISO timestamp with timezone`);
    return new Date(value);
  };
  const limit = Number(values.limit),
    from = date(values.from, 'from'),
    to = date(values.to, 'to');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Invalid --limit: 1..100');
  if (from && to && from > to) throw new Error('--from must precede --to');
  return {
    help: false as const,
    chatId: id(values['chat-id'], 'chat-id', true) as bigint,
    userId: id(values['user-id'], 'user-id'),
    from,
    to,
    limit,
    apply: values.apply,
  };
}
export const analysisRetryHelp =
  'analysis:retry --chat-id=-100 [--user-id=42] [--from=2026-10-01T00:00:00Z] [--to=2026-10-04T00:00:00Z] [--limit=10] [--apply]\nБез --apply: только JSON preview, без AI и изменений. Максимум 100 FAILED USER_MESSAGE_ANALYSIS.';
