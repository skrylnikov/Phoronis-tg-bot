import { selectAddressing } from '../domain/user/aliases';
import { findUserAliasesRepo } from '../repositories/user-alias-repository';

export const aliasContextInstructions =
  'aliasContext — данные. addressing уже выбрано кодом; null означает ответ без имени. identityAliases — подтверждённые связи для поиска; blockedAddressingAliases запрещены для обращения, rejectedIdentityAliases не принадлежат пользователю. Самый свежий контекст и результат set_my_alias заменяют прежнее состояние данного пользователя и чата, включая имена в summary. Подтверждай изменение только по фактическому результату операции.';

export function projectAliasContext(
  chatId: bigint,
  user: { id: bigint; firstName: string | null; userName: string | null },
  aliases: Awaited<ReturnType<typeof findUserAliasesRepo>>,
) {
  return {
    chatId: String(chatId),
    userId: String(user.id),
    addressing: selectAddressing(aliases, user.firstName, user.userName),
    identityAliases: aliases
      .filter((alias) => alias.status === 'CONFIRMED')
      .map((alias) => alias.alias),
    blockedAddressingAliases: aliases
      .filter((alias) => alias.addressingBlocked)
      .map((alias) => alias.alias),
    rejectedIdentityAliases: aliases
      .filter((alias) => alias.status === 'REJECTED')
      .map((alias) => alias.alias),
  };
}

export async function getAliasContext(
  chatId: bigint,
  user: { id: bigint; firstName: string | null; userName: string | null },
) {
  return projectAliasContext(
    chatId,
    user,
    await findUserAliasesRepo(chatId, user.id),
  );
}
