import { type Api, InlineKeyboard } from 'grammy';
import { sendWithRichFallback } from '../ai/rich-message';
import type { BotContext } from '../bot';
import { analyticsChatId } from '../config';
import { logger } from '../logger';
import {
  countMessageStatsByChatRepo,
  deactivateChatRepo,
  findActiveGroupChatsRepo,
} from '../repositories';

const confirmationLifetimeMs = 10 * 60 * 1000;
export const broadcastDelayMs = 2_000;

interface GroupChatTarget {
  id: bigint;
  title: string;
  markdown: string;
}

interface BroadcastConfirmation {
  groups: GroupChatTarget[];
  previewMarkdown: string;
  expiresAt: Date;
}

export interface WhatsNewStats {
  botReplies: number;
  recognizedVoices: number;
}

const confirmations = new Map<string, BroadcastConfirmation>();
const activeBroadcasters = new Set<number>();

function isOwner(ctx: BotContext): boolean {
  return ctx.chat?.type === 'private' && ctx.from?.id === analyticsChatId;
}

function createConfirmationToken(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 24);
}

function removeExpiredConfirmations(now = new Date()): void {
  for (const [token, confirmation] of confirmations) {
    if (confirmation.expiresAt <= now) confirmations.delete(token);
  }
}

export function buildWhatsNewPost(stats?: WhatsNewStats): string {
  return `## Ио: большое обновление

Я продолжаю становиться полезнее для ваших чатов. Спасибо, что доверяете мне ваши разговоры, вопросы и идеи 💜

### ✨ Что нового

- **Web-доступ с источниками** — Ио может искать актуальную информацию в интернете и показывать источники.
- **Контекст и история** — Ио лучше учитывает предыдущий разговор и умеет находить полезные сообщения в истории чата.
- **Изображения по запросу** — фотографии сами по себе не запускают распознавание и не расходуют лимит; Ио анализирует изображение только по явному запросу.
- **Более аккуратные ответы** — заголовки, списки, цитаты и другая структура отображаются понятнее.

### 📊 Лимиты: было → стало

<details><summary>Показать лимиты</summary>

| Тариф | Личные лимиты раньше | Личные лимиты сейчас | Лимиты группы раньше | Лимиты группы сейчас |
| --- | --- | --- | --- | --- |
| Без подписки | 3 ответа, 3 изображения, 3 войса, 1 анализ | 10 ответов, 5 изображений, 10 войсов, 1 анализ | — | — |
| 1 неделя | 13 ответов, 8 изображений, 8 войсов | 30 ответов, 15 изображений, 30 войсов | 1 ответ, 1 изображение, 1 войс, 1 анализ | 3 ответа, 3 изображения, 6 войсов, 1 анализ |
| 1 месяц | 28 ответов, 18 изображений, 18 войсов | 50 ответов, 30 изображений, 60 войсов | 3 ответа, 3 изображения, 3 войса, 3 анализа | 5 ответов, 5 изображений, 10 войсов, 3 анализа |
| 3 месяца | 53 ответа, 33 изображения, 33 войса | 100 ответов, 50 изображений, 100 войсов | 5 ответов, 5 изображений, 5 войсов, 5 анализов | 10 ответов, 10 изображений, 20 войсов, 5 анализов |
| 1 год | 103 ответа, 103 изображения, 103 войса | 500 ответов, 200 изображений, 400 войсов | 10 ответов, 10 изображений, 10 войсов, 10 анализов | 20 ответов, 20 изображений, 40 войсов, 10 анализов |

</details>

Лимиты обновляются каждый день по московскому времени. Неиспользованные лимиты не переносятся.

### ⭐ Скидка 20%

До **31 августа 2026 года, 23:59 МСК** действуют цены со скидкой 20% на все тарифы:

<details><summary>Показать цены</summary>

| Тариф | Было | Сейчас |
| --- | ---: | ---: |
| 1 неделя | 49 ⭐ | 39 ⭐ |
| 1 месяц | 99 ⭐ | 79 ⭐ |
| 3 месяца | 199 ⭐ | 159 ⭐ |
| 1 год | 599 ⭐ | 479 ⭐ |

</details>

${stats ? `_За всё время Ио ответила на ${stats.botReplies} сообщений и распознала ${stats.recognizedVoices} голосовых сообщений и кружков._` : '_Статистика в рассылке будет рассчитана отдельно для каждого группового чата._'}`;
}

async function getBroadcastData(botUserId: number): Promise<{
  groups: GroupChatTarget[];
  previewMarkdown: string;
}> {
  const activeGroups = await findActiveGroupChatsRepo();
  const statsByChat = await countMessageStatsByChatRepo(
    activeGroups.map((group) => group.id),
    BigInt(botUserId),
  );

  return {
    groups: activeGroups.map((group) => ({
      ...group,
      markdown: buildWhatsNewPost(
        statsByChat.get(group.id) ?? { botReplies: 0, recognizedVoices: 0 },
      ),
    })),
    previewMarkdown: buildWhatsNewPost(),
  };
}

async function sendPost(
  api: Api,
  chatId: bigint,
  markdown: string,
): Promise<void> {
  const targetChatId = Number(chatId);
  await sendWithRichFallback(
    markdown,
    (rich) => api.sendRichMessage(targetChatId, rich),
    (text) => api.sendMessage(targetChatId, text, { parse_mode: 'MarkdownV2' }),
    (text) => api.sendMessage(targetChatId, text),
  );
}

function waitForBroadcastDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, broadcastDelayMs));
}

async function runBroadcast(
  api: Api,
  ownerChatId: number,
  ownerUserId: number,
  confirmation: BroadcastConfirmation,
): Promise<void> {
  let sent = 0;
  try {
    for (const [index, group] of confirmation.groups.entries()) {
      try {
        await sendPost(api, group.id, group.markdown);
        sent += 1;
      } catch (error) {
        logger.warn(
          {
            event: 'whats_new.broadcast_group_failed',
            err: error,
            chatId: group.id.toString(),
            title: group.title,
          },
          'Failed to send whats-new broadcast',
        );
        try {
          await deactivateChatRepo(group.id);
        } catch (deactivationError) {
          logger.error(
            {
              event: 'whats_new.broadcast_deactivation_failed',
              err: deactivationError,
              chatId: group.id.toString(),
            },
            'Failed to deactivate whats-new target chat',
          );
        }
      }

      if (index < confirmation.groups.length - 1) {
        await waitForBroadcastDelay();
      }
    }

    await api.sendMessage(
      ownerChatId,
      [
        'Рассылка завершена.',
        `Всего групп: ${confirmation.groups.length}`,
        `Успешно отправлено: ${sent}`,
        `Не доставлено: ${confirmation.groups.length - sent}`,
      ].join('\n'),
    );
  } catch (error) {
    logger.error(
      { event: 'whats_new.broadcast_failed', err: error },
      'Whats-new broadcast failed',
    );
  } finally {
    activeBroadcasters.delete(ownerUserId);
  }
}

export async function whatsNewController(ctx: BotContext): Promise<void> {
  if (!isOwner(ctx) || !ctx.from) return;

  removeExpiredConfirmations();
  if (activeBroadcasters.has(ctx.from.id)) {
    await ctx.reply('Рассылка уже выполняется.');
    return;
  }

  const { groups, previewMarkdown } = await getBroadcastData(ctx.me.id);
  const token = createConfirmationToken();
  confirmations.set(token, {
    groups,
    previewMarkdown,
    expiresAt: new Date(Date.now() + confirmationLifetimeMs),
  });

  const preview = `${previewMarkdown}\n\n> Готово к отправке в ${groups.length} активных групповых чатов. Статистика будет рассчитана отдельно для каждого чата.`;
  const replyMarkup = new InlineKeyboard().text(
    'Разослать',
    `whatsnew:${token}`,
  );
  await sendWithRichFallback(
    preview,
    (rich) => ctx.replyWithRichMessage(rich, { reply_markup: replyMarkup }),
    (text) =>
      ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: replyMarkup }),
    (text) => ctx.reply(text, { reply_markup: replyMarkup }),
  );
}

export async function whatsNewCallbackController(
  ctx: BotContext,
): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const match = data ? /^whatsnew:([a-z0-9]+)$/i.exec(data) : null;
  if (!match) return;
  if (!isOwner(ctx) || !ctx.from || !ctx.chatId) {
    await ctx.answerCallbackQuery({ text: 'Недоступно' });
    return;
  }

  removeExpiredConfirmations();
  const confirmation = confirmations.get(match[1]);
  if (!confirmation) {
    await ctx.answerCallbackQuery({ text: 'Подтверждение устарело' });
    return;
  }
  if (activeBroadcasters.has(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: 'Рассылка уже выполняется' });
    return;
  }

  activeBroadcasters.add(ctx.from.id);
  try {
    await ctx.answerCallbackQuery({ text: 'Рассылка началась' });
    confirmations.delete(match[1]);
    await ctx
      .editMessageReplyMarkup()
      .catch((error) =>
        logger.warn(
          { event: 'whats_new.confirmation_remove_failed', err: error },
          'Failed to remove whats-new confirmation button',
        ),
      );
    void runBroadcast(ctx.api, ctx.chatId, ctx.from.id, confirmation);
  } catch (error) {
    activeBroadcasters.delete(ctx.from.id);
    throw error;
  }
}
