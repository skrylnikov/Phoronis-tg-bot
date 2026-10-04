import { getAliasContext } from '../../ai/alias-context';
import type { BotContext } from '../../bot';
import { logger } from '../../logger';
import {
  findUserAliasesRepo,
  setMyAliasRepo,
} from '../../repositories/user-alias-repository';
import { throwIfUpdateAborted } from '../../update-signal';
import { normalizeAlias, validateAlias } from './aliases';

type OwnerAction = 'prefer' | 'avoid_addressing' | 'reject_identity';
export function parseOwnerAliasCommand(ctx: BotContext) {
  const msg = ctx.msg;
  if (
    !ctx.from ||
    ctx.chatId === undefined ||
    !msg ||
    msg.guest_query_id ||
    msg.forward_origin
  )
    return null;
  let text = msg.text ?? msg.caption ?? '';
  if (
    /[«»"“”\n]/u.test(text) ||
    [...(msg.entities ?? []), ...(msg.caption_entities ?? [])].some(
      (e) => e.type === 'blockquote' || e.type === 'expandable_blockquote',
    )
  )
    return null;
  text = text.trim().replace(/^ио(?:[, :]+|$)/iu, '');
  const mention = text.match(/^@(\w+)[, :]+/u);
  if (mention) {
    if (mention[1]?.toLowerCase() !== ctx.me?.username?.toLowerCase())
      return null;
    text = text.slice(mention[0].length);
  }
  text = text.replace(/^пожалуйста,?\s+/iu, '');
  const patterns: Array<[OwnerAction, RegExp]> = [
    ['prefer', /^(?:называй|зови) меня\s+(.+?)[.!]?$/iu],
    ['avoid_addressing', /^не (?:называй|зови) меня\s+(.+?)[.!]?$/iu],
    [
      'reject_identity',
      /^(.+?)\s*[-—–,:]?\s*(?:это )?не мой псевдоним[.!]?$/iu,
    ],
  ];
  for (const [action, pattern] of patterns) {
    const match = text.match(pattern);
    const name = validateAlias(match?.[1]);
    if (name && !/[,;:!?]/u.test(name.alias)) return { action, ...name };
  }
  return null;
}

export function resolveOwnerAlias(
  requested: string,
  existing: Array<{ alias: string; normalizedAlias: string }>,
  action: OwnerAction = 'avoid_addressing',
) {
  const normalized = normalizeAlias(requested);
  const exact = existing.find((a) => a.normalizedAlias === normalized);
  if (exact) return { alias: exact.alias };
  // ponytail: only instrumental forms of known names; add verified endings rather than fuzzy matching.
  const matches = existing.filter(({ normalizedAlias: name }) => {
    const forms = [`${name}ом`, `${name}ем`];
    if (name.endsWith('а'))
      forms.push(
        `${name.slice(0, -1)}${/[жшчщц]а$/u.test(name) ? 'ей' : 'ой'}`,
      );
    if (name.endsWith('я')) forms.push(`${name.slice(0, -1)}ей`);
    if (name.endsWith('й') || name.endsWith('ь'))
      forms.push(`${name.slice(0, -1)}ем`);
    return forms.includes(normalized);
  });
  if (matches.length === 1) return { alias: matches[0].alias };
  if (
    matches.length > 1 ||
    (action !== 'prefer' && /(?:ом|ем|ой|ей)$/u.test(normalized))
  )
    return {
      error: 'Уточни псевдоним в исходной форме; изменение не сохранено.',
    };
  return { alias: requested };
}

export async function applyOwnerAliasCommand(
  ctx: BotContext,
  expected?: { alias: string; action: OwnerAction },
) {
  const command = parseOwnerAliasCommand(ctx);
  if (!command || !ctx.from || ctx.chatId === undefined || !ctx.msg)
    return {
      error: 'Нужна явная просьба о собственном псевдониме в текущем сообщении',
    };
  try {
    const chatId = BigInt(ctx.chatId),
      userId = BigInt(ctx.from.id);
    const resolved = resolveOwnerAlias(
      command.alias,
      await findUserAliasesRepo(chatId, userId),
      command.action,
    );
    if (resolved.error || !resolved.alias) return { error: resolved.error };
    if (
      expected &&
      (expected.action !== command.action ||
        normalizeAlias(expected.alias) !== normalizeAlias(resolved.alias))
    )
      return { error: 'Имя и действие должны соответствовать текущей просьбе' };
    throwIfUpdateAborted();
    const outcome = await setMyAliasRepo({
      chatId,
      userId,
      messageId: BigInt(ctx.msg.message_id),
      alias: resolved.alias,
      action: command.action,
    });
    const aliasContext = await getAliasContext(chatId, {
      id: userId,
      firstName: ctx.from.first_name,
      userName: ctx.from.username ?? null,
    });
    const confirmation =
      outcome === 'superseded'
        ? 'Уже действует более новая просьба; это изменение не применено.'
        : outcome === 'already_applied'
          ? 'Эта просьба уже сохранена.'
          : command.action === 'prefer'
            ? `Буду называть тебя ${resolved.alias}.`
            : command.action === 'avoid_addressing'
              ? `Больше не буду использовать «${resolved.alias}» как обращение.`
              : `«${resolved.alias}» больше не считается твоим псевдонимом.`;
    return { success: true, outcome, aliasContext, confirmation };
  } catch (error) {
    logger.error(
      {
        event: 'user_alias.owner_update_failed',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      },
      'Failed to update own alias',
    );
    return { error: 'Не удалось сохранить обращение' };
  }
}
