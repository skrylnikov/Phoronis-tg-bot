import type { Api } from 'grammy';

const groupScope = { type: 'all_group_chats' as const };
const askCommand = {
  command: 'ask',
  description: 'Спросить Ио приватно',
  is_ephemeral: true,
};

export async function registerBotCommands(api: Api): Promise<void> {
  const [defaultCommands, groupCommands] = await Promise.all([
    api.getMyCommands(),
    api.getMyCommands({ scope: groupScope }),
  ]);
  const baseCommands =
    groupCommands.length > 0 ? groupCommands : defaultCommands;
  const commands = [
    ...baseCommands.filter((command) => command.command !== askCommand.command),
    askCommand,
  ];

  await api.setMyCommands(commands, { scope: groupScope });
}
