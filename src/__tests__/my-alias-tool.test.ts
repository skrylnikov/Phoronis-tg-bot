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
    me: { username: 'phoronis_bot' },
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
  write.mockResolvedValue('applied');
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

it.each([
  ['Саша', 'Сашей'],
  ['Дима', 'Димой'],
])('resolves the known %s name from %s', async (alias, instrumental) => {
  read.mockResolvedValue([{ alias, normalizedAlias: alias.toLowerCase() }]);
  expect(
    await execute(`не называй меня ${instrumental}`, {
      alias,
      action: 'avoid_addressing',
    }),
  ).toHaveProperty('success', true);
  expect(write).toHaveBeenCalledWith(expect.objectContaining({ alias }));
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

it('never substitutes a different saved alias for the literal request', async () => {
  read.mockResolvedValue([{ alias: 'Шурик', normalizedAlias: 'шурик' }]);
  expect(
    await execute('называй меня Саша', { alias: 'Шурик', action: 'prefer' }),
  ).toHaveProperty('error');
  expect(
    await execute('не называй меня Саша', {
      alias: 'Шурик',
      action: 'avoid_addressing',
    }),
  ).toHaveProperty('error');
  expect(write).not.toHaveBeenCalled();
});

it('parses addressed requests with original casing and reports persisted outcomes', async () => {
  for (const prefix of ['Ио, ', '@phoronis_bot ']) {
    expect(
      await execute(`${prefix}называй меня САША`, {
        alias: 'САША',
        action: 'prefer',
      }),
    ).toMatchObject({ success: true, outcome: 'applied' });
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({ alias: 'САША' }),
    );
  }
  expect(
    await execute('@other_bot называй меня Саша', {
      alias: 'Саша',
      action: 'prefer',
    }),
  ).toHaveProperty('error');
  write.mockResolvedValue('superseded');
  expect(
    await execute('называй меня Саша', { alias: 'Саша', action: 'prefer' }),
  ).toMatchObject({
    outcome: 'superseded',
    confirmation: expect.stringContaining('не применено'),
  });
  write.mockResolvedValue('already_applied');
  expect(
    await execute('называй меня Саша', { alias: 'Саша', action: 'prefer' }),
  ).toHaveProperty('outcome', 'already_applied');
});
it('asks for unknown inflections and ambiguous canonical matches without writing', async () => {
  expect(
    await execute('не называй меня Димой', {
      alias: 'Дима',
      action: 'avoid_addressing',
    }),
  ).toHaveProperty('error');
  read.mockResolvedValue([
    { alias: 'Шурь', normalizedAlias: 'шурь' },
    { alias: 'Шурй', normalizedAlias: 'шурй' },
  ]);
  expect(
    await execute('не называй меня Шурем', {
      alias: 'Шурь',
      action: 'avoid_addressing',
    }),
  ).toHaveProperty('error');
  expect(write).not.toHaveBeenCalled();
});

it('preserves a literal new preferred name even when its ending resembles an inflection', async () => {
  expect(
    await execute('называй меня Том', { alias: 'Том', action: 'prefer' }),
  ).toMatchObject({ success: true, outcome: 'applied' });
  expect(write).toHaveBeenCalledWith(expect.objectContaining({ alias: 'Том' }));
});

it('refuses forwarded and quoted owner commands and supports an original caption', async () => {
  for (const patch of [
    { forward_origin: {} },
    { entities: [{ type: 'blockquote', offset: 0, length: 20 }] },
  ]) {
    const ctx = context('называй меня Саша');
    Object.assign(ctx.msg ?? {}, patch);
    const tool = createMyAliasTool(ctx);
    expect(
      JSON.parse(
        String(
          await tool.execute?.(
            { alias: 'Саша', action: 'prefer' },
            {} as never,
          ),
        ),
      ),
    ).toHaveProperty('error');
  }
  expect(write).not.toHaveBeenCalled();
  const ctx = context('');
  Object.assign(ctx.msg ?? {}, {
    text: undefined,
    caption: 'Ио, называй меня Саша',
  });
  const tool = createMyAliasTool(ctx);
  expect(
    JSON.parse(
      String(
        await tool.execute?.({ alias: 'Саша', action: 'prefer' }, {} as never),
      ),
    ),
  ).toMatchObject({ outcome: 'applied' });
});
