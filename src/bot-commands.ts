import type { Api } from 'grammy';

const groupScope = { type: 'all_group_chats' as const };
const askCommand = {
  command: 'ask',
  description: 'Спросить Ио приватно',
  is_ephemeral: true,
};
const monetizationGroupCommands = [
  askCommand,
  {
    command: 'subscribe',
    description: 'Оформить подписку',
  },
  { command: 'limits', description: 'Посмотреть лимиты' },
  { command: 'subscription', description: 'Моя подписка' },
];
const privateCommands = [
  { command: 'limits', description: 'Посмотреть лимиты' },
  { command: 'subscription', description: 'Моя подписка' },
  { command: 'terms', description: 'Условия подписки' },
  { command: 'paysupport', description: 'Поддержка по оплате' },
];

export async function registerBotCommands(api: Api): Promise<void> {
  const [defaultCommands, registeredGroupCommands] = await Promise.all([
    api.getMyCommands(),
    api.getMyCommands({ scope: groupScope }),
  ]);
  const baseCommands =
    registeredGroupCommands.length > 0
      ? registeredGroupCommands
      : defaultCommands;
  const commands = [
    ...baseCommands.filter(
      (command) =>
        !monetizationGroupCommands.some(
          (replacement) => replacement.command === command.command,
        ),
    ),
    ...monetizationGroupCommands,
  ];

  await Promise.all([
    api.setMyCommands(commands, { scope: groupScope }),
    api.setMyCommands(
      [
        ...defaultCommands.filter(
          (command) =>
            !privateCommands.some(
              (replacement) => replacement.command === command.command,
            ),
        ),
        ...privateCommands,
      ],
      { scope: { type: 'all_private_chats' } },
    ),
  ]);
}
