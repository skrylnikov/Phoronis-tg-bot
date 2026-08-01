import { generateText } from 'ai';
import { utilityModel } from '../ai/ai';
import { sendWithRichFallback } from '../ai/rich-message';
import { bot } from '../bot';
import { logger } from '../logger';
import { saveMessage } from '../shared';

// Функция для генерации сообщения
async function generateSelfieMessage(): Promise<string> {
  try {
    const message = await generateText({
      model: utilityModel,
      prompt: `Придумай короткое и веселое сообщение с саркастичным подтекстом для чата, призывающее людей постить свои селфи в субботу.
Обязательно добавь хэштег #селфисуббота и один дурацкий эмодзи.
Используй Telegram Rich Markdown, если разметка уместна, и не добавляй внешние медиа по URL.`,
      temperature: 1,
    }).then((r) => r.text);
    return message;
  } catch (error) {
    logger.error(
      { event: 'feature.selfie_generation_failed', err: error },
      'Ошибка при генерации сообщения для Селфи Субботы',
    );
    // Возвращаем стандартное сообщение в случае ошибки
    return 'Всем привет! Сегодня суббота, время для селфи! 🤪\n#селфисуббота';
  }
}

// Функция для отправки сообщения в конкретный чат
export async function sendSelfieSaturdayMessage(
  chatId: number | bigint,
): Promise<void> {
  const message = await generateSelfieMessage();
  try {
    // Убедимся, что chatId - это number или string для API Telegram
    const targetChatId = typeof chatId === 'bigint' ? Number(chatId) : chatId;
    const reply = await sendWithRichFallback(
      message,
      (rich) => bot.api.sendRichMessage(targetChatId, rich),
      (text) =>
        bot.api.sendMessage(targetChatId, text, { parse_mode: 'MarkdownV2' }),
      (text) => bot.api.sendMessage(targetChatId, text),
    );
    logger.info(
      { event: 'feature.selfie_message_sent', chatId: targetChatId },
      'Selfie Saturday message sent',
    );

    await saveMessage({
      id: reply.message_id,
      chatId,
      senderId: reply.from?.id ?? 0,
      sentAt: new Date(reply.date * 1000),
      messageType: 'TEXT',
      text: message,
    });
  } catch (error) {
    logger.error(
      {
        event: 'feature.selfie_send_failed',
        err: error,
        chatId: Number(chatId),
      },
      'Ошибка при отправке сообщения Селфи Субботы',
    );
    // Здесь можно добавить логику обработки ошибок, например, отключить фичу для этого чата, если бот заблокирован
  }
}
