import type { Api } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { registerBotCommands } from '../bot-commands';

describe('registerBotCommands', () => {
  it('merges /ask into existing group commands as ephemeral', async () => {
    const getMyCommands = vi
      .fn()
      .mockResolvedValueOnce([{ command: 'start', description: 'Start' }])
      .mockResolvedValueOnce([{ command: 'status', description: 'Status' }]);
    const setMyCommands = vi.fn().mockResolvedValue(true);
    const api = { getMyCommands, setMyCommands } as unknown as Api;

    await registerBotCommands(api);

    expect(setMyCommands).toHaveBeenNthCalledWith(
      1,
      [
        { command: 'status', description: 'Status' },
        {
          command: 'ask',
          description: 'Спросить Ио приватно',
          is_ephemeral: true,
        },
        {
          command: 'subscribe',
          description: 'Оформить подписку',
        },
        {
          command: 'limits',
          description: 'Посмотреть лимиты',
        },
        {
          command: 'subscription',
          description: 'Моя подписка',
        },
      ],
      { scope: { type: 'all_group_chats' } },
    );
    expect(setMyCommands).toHaveBeenNthCalledWith(
      2,
      [
        { command: 'start', description: 'Start' },
        { command: 'limits', description: 'Посмотреть лимиты' },
        { command: 'subscription', description: 'Моя подписка' },
        { command: 'terms', description: 'Условия подписки' },
        { command: 'paysupport', description: 'Поддержка по оплате' },
      ],
      { scope: { type: 'all_private_chats' } },
    );
  });

  it('uses default commands when the group scope is empty', async () => {
    const getMyCommands = vi
      .fn()
      .mockResolvedValueOnce([{ command: 'start', description: 'Start' }])
      .mockResolvedValueOnce([]);
    const setMyCommands = vi.fn().mockResolvedValue(true);

    await registerBotCommands({
      getMyCommands,
      setMyCommands,
    } as unknown as Api);

    expect(setMyCommands.mock.calls[0]?.[0]).toEqual([
      { command: 'start', description: 'Start' },
      {
        command: 'ask',
        description: 'Спросить Ио приватно',
        is_ephemeral: true,
      },
      {
        command: 'subscribe',
        description: 'Оформить подписку',
      },
      {
        command: 'limits',
        description: 'Посмотреть лимиты',
      },
      {
        command: 'subscription',
        description: 'Моя подписка',
      },
    ]);
  });
});
