import { generateText } from 'ai';
import MD from 'telegramify-markdown';
import { openRouter } from '../ai/ai';
import { bot } from '../bot';
import { logger } from '../logger';
import { saveMessage } from '../shared';

// Функция для генерации сообщения
async function generateSelfieMessage(): Promise<string> {
  try {
    const message = await generateText({
      model: openRouter('google/gemini-2.5-flash-lite'),
      prompt: `Придумай короткое и веселое сообщение с саркастичным подтекстом для чата, призывающее людей постить свои селфи в субботу.
Обязательно добавь хэштег #селфисуббота и один дурацкий эмодзи.`,
      temperature: 1,
    }).then((r) => r.text);
    return message;
  } catch (error) {
    logger.error(error, 'Ошибка при генерации сообщения для Селфи Субботы');
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
    const reply = await bot.api.sendMessage(
      targetChatId,
      MD(message, 'remove'),
      {
        parse_mode: 'MarkdownV2',
      },
    );
    logger.info(`Сообщение Селфи Субботы отправлено в чат ${targetChatId}`);

    await saveMessage({
      id: reply.message_id,
      chatId,
      senderId: reply.from!.id,
      sentAt: new Date(reply.date * 1000),
      messageType: 'TEXT',
      text: message,
    });
  } catch (error) {
    logger.error(
      error,
      `Ошибка при отправке сообщения Селфи Субботы в чат ${chatId}`,
    );
    // Здесь можно добавить логику обработки ошибок, например, отключить фичу для этого чата, если бот заблокирован
  }
}
