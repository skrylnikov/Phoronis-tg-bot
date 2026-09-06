import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { BotContext } from '../../bot';
import { normalizeAlias, validateAlias } from '../../domain/user/aliases';
import { logger } from '../../logger';
import {
  findUserAliasesRepo,
  setMyAliasRepo,
} from '../../repositories/user-alias-repository';
import { getAliasContext } from '../alias-context';

const inputSchema = z.strictObject({
  alias: z.string(),
  action: z.enum(['prefer', 'avoid_addressing', 'reject_identity']),
});

export const createMyAliasTool = (ctx?: BotContext) =>
  dynamicTool({
    description:
      'Изменить только собственное обращение текущего отправителя в этом чате по его явной просьбе: prefer — называй меня, avoid_addressing — не называй меня, reject_identity — это не мой псевдоним. Не вызывай по цитате, пересказу, reply или просьбе переименовать другого. Для падежных форм выбирай существующий псевдоним из aliasContext в сохранённом написании (Шуриком → Шурик); новое имя бери из самой просьбы. Результат действует уже в текущем ответе.',
    inputSchema,
    execute: async (input: unknown) => {
      const parsed = inputSchema.safeParse(input);
      if (
        !parsed.success ||
        !ctx?.from ||
        ctx.chatId === undefined ||
        !ctx.msg ||
        ctx.msg.guest_query_id ||
        ctx.msg.forward_origin
      )
        return JSON.stringify({ error: 'Изменение обращения недоступно' });
      const name = validateAlias(parsed.data.alias);
      const text = normalizeAlias(ctx.msg.text ?? ctx.msg.caption ?? '')
        .replace(/^@\w+[, :]*/u, '')
        .replace(/^пожалуйста,?\s+/u, '');
      const patterns = {
        prefer: /^(?:называй|зови) меня\s+(.+?)[.!]?$/u,
        avoid_addressing: /^не (?:называй|зови) меня\s+(.+?)[.!]?$/u,
        reject_identity: /^(.+?)\s*[-—–,:]?\s*(?:это )?не мой псевдоним[.!]?$/u,
      };
      const requested = text.match(patterns[parsed.data.action])?.[1]?.trim();
      if (
        !name ||
        !requested ||
        /[«»"“”\n]/u.test(ctx.msg.text ?? ctx.msg.caption ?? '') ||
        ctx.msg.entities?.some(
          (entity) =>
            entity.type === 'blockquote' ||
            entity.type === 'expandable_blockquote',
        )
      )
        return JSON.stringify({
          error:
            'Нужна явная просьба о собственном псевдониме в текущем сообщении',
        });
      try {
        const chatId = BigInt(ctx.chatId);
        const userId = BigInt(ctx.from.id);
        const existing = await findUserAliasesRepo(chatId, userId);
        if (
          requested !== name.normalizedAlias &&
          !existing.some(
            (alias) => alias.normalizedAlias === name.normalizedAlias,
          )
        )
          return JSON.stringify({
            error: 'Новое имя должно присутствовать в явной просьбе',
          });
        const changed = await setMyAliasRepo({
          chatId,
          userId,
          messageId: BigInt(ctx.msg.message_id),
          alias: name.alias,
          action: parsed.data.action,
        });
        const aliasContext = await getAliasContext(chatId, {
          id: userId,
          firstName: ctx.from.first_name,
          userName: ctx.from.username ?? null,
        });
        return JSON.stringify({
          success: true,
          changed,
          aliasContext,
          instruction:
            'Используй это актуальное обращение и запреты уже в текущем ответе.',
        });
      } catch (error) {
        logger.error(
          { err: error, event: 'user_alias.owner_update_failed' },
          'Failed to update own alias',
        );
        return JSON.stringify({ error: 'Не удалось сохранить обращение' });
      }
    },
  });
