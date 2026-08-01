import { type Api, InlineKeyboard } from 'grammy';
import { sendWithRichFallback } from '../ai/rich-message';
import type { BotContext } from '../bot';
import { analyticsChatId } from '../config';
import { prisma } from '../db';
import { logger } from '../logger';
import { weeklyPromotionEndsAt } from '../shared';

const confirmationLifetimeMs = 10 * 60 * 1000;
export const broadcastDelayMs = 2_000;

interface GroupChatTarget {
  id: bigint;
  title: string;
}

interface BroadcastConfirmation {
  groups: GroupChatTarget[];
  markdown: string;
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

function formatPromotion(now: Date): string {
  if (now >= weeklyPromotionEndsAt) return '';

  return `
<details>
<summary>🔥 Акция до 3 августа, 00:00 МСК</summary>

Сейчас действуют специальные цены: **29 / 49 / 99 / 299 ⭐** вместо **49 / 99 / 199 / 599 ⭐** за неделю, месяц, квартал и год.

</details>`;
}

export function buildWhatsNewPost(
  stats: WhatsNewStats,
  now = new Date(),
): string {
  return `## Ио: большое обновление

Я переехала на новую инфраструктуру — теперь работаю быстрее и стабильнее. Спасибо, что доверяете мне ваши разговоры, вопросы и идеи 💜

<details>
<summary>✨ Что нового</summary>

- **Rich Markdown** — ответы стали аккуратнее: с заголовками, списками, цитатами и удобной структурой.
- **Приватный /ask** — задайте вопрос в группе, и Ио ответит только вам; такой диалог не попадает в обычную историю группы.
- **Guest Mode** — Ио можно позвать в чат, где её ещё нет.
- **«Что я пропустил?»** — в группе можно попросить Ио разобрать сообщения после вашего последнего появления и кратко рассказать важное.
- **Улучшенный контекст** — Ио лучше находит полезные детали из истории диалога.

</details>

<details>
<summary>⭐ Подписка и лимиты</summary>

Подписка оформляется командой **/subscribe** в нужной группе: выбор и оплата проходят в личном чате с Ио через Telegram Stars, без автоматического продления. Она прибавляет тариф к бесплатным личным лимитам и добавляет групповые лимиты каждому участнику выбранной группы.

| Тариф | Цена сейчас | Личные лимиты в день | Групповые лимиты каждого участника в день |
| --- | --- | --- | --- |
| 1 неделя | 29 ⭐ вместо 49 ⭐ | 13 ответов, 8 изображений, 8 войсов, безлимит анализа | 1 ответ, 1 изображение, 1 войс, 1 анализ |
| 1 месяц | 49 ⭐ вместо 99 ⭐ | 28 ответов, 18 изображений, 18 войсов, безлимит анализа | 3 ответа, 3 изображения, 3 войса, 3 анализа |
| 3 месяца | 99 ⭐ вместо 199 ⭐ | 53 ответа, 33 изображения, 33 войса, безлимит анализа | 5 ответов, 5 изображений, 5 войсов, 5 анализов |
| 1 год | 299 ⭐ вместо 599 ⭐ | 103 ответа, 103 изображения, 103 войса, безлимит анализа | 10 ответов, 10 изображений, 10 войсов, 10 анализов |

Без подписки: **3 ответа, 3 изображения, 3 войса и 1 анализ** в день. Например, неделя даёт **3 бесплатных + 10 по тарифу = 13 ответов**. В группе сначала расходуется ваш групповой лимит, затем — личный. Покупки, действующие одновременно, складываются: подписки одной группы увеличивают групповую квоту каждого её участника, но участники не тратят лимиты друг друга. В **/limits** эти два вида лимитов показаны отдельно.

Все лимиты обновляются в **00:00 МСК**. Неиспользованные не переносятся; дни новой покупки добавляются после уже оплаченного срока. Пока подписка активна, можно купить такой же или более высокий тариф.

</details>${formatPromotion(now)}

Спасибо, что вы с Ио. Продолжаю делать её полезнее для ваших чатов.

_За всё время Ио ответила на ${stats.botReplies} сообщений и распознала ${stats.recognizedVoices} голосовых сообщений и кружков._`;
}

async function getBroadcastData(botUserId: number): Promise<{
  groups: GroupChatTarget[];
  stats: WhatsNewStats;
}> {
  const [groups, botReplies, recognizedVoices] = await Promise.all([
    prisma.chat.findMany({
      where: { chatType: 'GROUP' },
      select: { id: true, title: true },
    }),
    prisma.message.count({
      where: { senderId: BigInt(botUserId), replyToMessageId: { not: null } },
    }),
    prisma.message.count({
      where: {
        messageType: 'VOICE',
        senderId: { not: BigInt(botUserId) },
      },
    }),
  ]);

  return { groups, stats: { botReplies, recognizedVoices } };
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
        await sendPost(api, group.id, confirmation.markdown);
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

  const { groups, stats } = await getBroadcastData(ctx.me.id);
  const token = createConfirmationToken();
  const markdown = buildWhatsNewPost(stats);
  confirmations.set(token, {
    groups,
    markdown,
    expiresAt: new Date(Date.now() + confirmationLifetimeMs),
  });

  const preview = `${markdown}\n\n> Готово к отправке в ${groups.length} групповых чатов.`;
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
