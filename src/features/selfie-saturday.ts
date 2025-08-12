import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { openRouterToken } from "../config"; // Импортируем токен
import { bot } from "../bot"; // Импортируем экземпляр бота
import { logger } from "../logger"; // Импортируем логгер

// Используем ту же модель, что и в chat-generation
const geminiFlash2 = new ChatOpenAI({
  model: "google/gemini-2.5-flash-lite",
  apiKey: openRouterToken,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
  },
  temperature: 1, // Можно сделать температуру повыше для креативности
});

// Промпт для генерации сообщения
const promptTemplate = PromptTemplate.fromTemplate(
  `Придумай короткое и веселое сообщение с саркастичным подтекстом для чата, призывающее людей постить свои селфи в субботу.
  Обязательно добавь хэштег #селфисуббота и один дурацкий эмодзи.
  Не используй markdown.`
);

const outputParser = new StringOutputParser();

const chain = promptTemplate.pipe(geminiFlash2).pipe(outputParser);

// Функция для генерации сообщения
async function generateSelfieMessage(): Promise<string> {
  try {
    const message = await chain.invoke({});
    // Дополнительная проверка или форматирование, если нужно
    if (!message.includes("#селфисуббота")) {
        return message + "\n#селфисуббота"; // Гарантируем наличие хештега
    }
    return message;
  } catch (error) {
    logger.error("Ошибка при генерации сообщения для Селфи Субботы:", error);
    // Возвращаем стандартное сообщение в случае ошибки
    return "Всем привет! Сегодня суббота, время для селфи! 🤪\n#селфисуббота";
  }
}

// Функция для отправки сообщения в конкретный чат
export async function sendSelfieSaturdayMessage(chatId: number | bigint): Promise<void> {
  const message = await generateSelfieMessage();
  try {
    // Убедимся, что chatId - это number или string для API Telegram
    const targetChatId = typeof chatId === 'bigint' ? Number(chatId) : chatId;
    await bot.api.sendMessage(targetChatId, message);
    logger.info(`Сообщение Селфи Субботы отправлено в чат ${targetChatId}`);
  } catch (error) {
    logger.error(`Ошибка при отправке сообщения Селфи Субботы в чат ${chatId}:`, error);
    // Здесь можно добавить логику обработки ошибок, например, отключить фичу для этого чата, если бот заблокирован
  }
} 
