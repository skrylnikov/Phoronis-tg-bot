import { beforeEach, expect, it, vi } from 'vitest';
import type { BotContext } from '../bot';

const { read, write } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('../repositories/user-alias-repository', () => ({
  findUserAliasesRepo: read,
  setMyAliasRepo: write,
}));
vi.mock('../logger', () => ({ logger: { error: vi.fn() } }));

import { createMyAliasTool } from '../ai/tools/my-alias';

function context(text: string, guest = false): BotContext {
  return {
    from: { id: 42, first_name: 'Александр' },
    chatId: -100,
    msg: {
      message_id: 10,
      text,
      ...(guest ? { guest_query_id: 'guest' } : {}),
    },
  } as unknown as BotContext;
}
async function execute(text: string, input: unknown, guest = false) {
  const tool = createMyAliasTool(context(text, guest));
  if (!tool.execute) throw new Error('Missing tool');
  return JSON.parse(String(await tool.execute(input, {} as never)));
}

beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue([]);
  write.mockResolvedValue(true);
});

it('binds explicit owner actions to sender/chat and returns current context', async () => {
  for (const [text, action] of [
    ['называй меня Саша', 'prefer'],
    ['не называй меня Саша', 'avoid_addressing'],
    ['Саша не мой псевдоним', 'reject_identity'],
  ] as const) {
    expect(await execute(text, { alias: 'Саша', action })).toMatchObject({
      success: true,
      aliasContext: { chatId: '-100', userId: '42' },
    });
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: -100n,
        userId: 42n,
        messageId: 10n,
        alias: 'Саша',
        action,
      }),
    );
  }
});

it('allows the model to select an existing alias for an inflected owner request', async () => {
  read.mockResolvedValue([
    {
      alias: 'Шурик',
      normalizedAlias: 'шурик',
      status: 'CONFIRMED',
      confidence: 0.92,
      authorCount: 2,
      neutralForAddressing: true,
    },
  ]);
  expect(
    await execute('не называй меня Шуриком', {
      alias: 'Шурик',
      action: 'avoid_addressing',
    }),
  ).toHaveProperty('success', true);
});

it('rejects quotes, other people, guest writes and invalid inputs without claiming success', async () => {
  for (const text of [
    'Он сказал: называй меня Саша',
    '«называй меня Саша»',
    'называй Ивана Саша',
    'Привет',
  ])
    expect(
      await execute(text, { alias: 'Саша', action: 'prefer' }),
    ).toHaveProperty('error');
  expect(
    await execute('называй меня Саша', {
      alias: 'Саша',
      action: 'prefer',
      userId: '999',
    }),
  ).toHaveProperty('error');
  expect(
    await execute('называй меня Саша', { alias: '@name', action: 'prefer' }),
  ).toHaveProperty('error');
  expect(
    await execute(
      'называй меня Саша',
      { alias: 'Саша', action: 'prefer' },
      true,
    ),
  ).toHaveProperty('error');
  expect(write).not.toHaveBeenCalled();
  write.mockRejectedValue(new Error('database unavailable'));
  expect(
    await execute('называй меня Саша', { alias: 'Саша', action: 'prefer' }),
  ).toEqual({ error: 'Не удалось сохранить обращение' });
});
