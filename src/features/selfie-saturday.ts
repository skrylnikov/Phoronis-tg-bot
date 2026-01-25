import { StringOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import MD from 'telegramify-markdown';
import { bot } from '../bot'; // Импортируем экземпляр бота
import { openRouterToken } from '../config'; // Импортируем токен
import { prisma } from '../db';
import { logger } from '../logger'; // Импортируем логгер

// Используем ту же модель, что и в chat-generation
const geminiFlash2 = new ChatOpenAI({
  model: 'google/gemini-2.5-flash-lite',
  apiKey: openRouterToken,
  configuration: {
    baseURL: 'https://openrouter.ai/api/v1',
  },
  temperature: 1, // Можно сделать температуру повыше для креативности
});

// Промпт для генерации сообщения
const promptTemplate = PromptTemplate.fromTemplate(
  `Придумай короткое и веселое сообщение с саркастичным подтекстом для чата, призывающее людей постить свои селфи в субботу.
  Обязательно добавь хэштег #селфисуббота и один дурацкий эмодзи.`,
);

const outputParser = new StringOutputParser();

const chain = promptTemplate.pipe(geminiFlash2).pipe(outputParser);

// Функция для генерации сообщения
async function generateSelfieMessage(): Promise<string> {
  try {
    const message = await chain.invoke({});
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

    await prisma.message.create({
      data: {
        id: reply.message_id,
        chatId,
        senderId: reply.from!.id,
        replyToMessageId: null,
        sentAt: new Date(reply.date * 1000),
        messageType: 'TEXT',
        text: message,
      },
    });
  } catch (error) {
    logger.error(
      error,
      `Ошибка при отправке сообщения Селфи Субботы в чат ${chatId}`,
    );
    // Здесь можно добавить логику обработки ошибок, например, отключить фичу для этого чата, если бот заблокирован
  }
}
