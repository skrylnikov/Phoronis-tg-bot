import { ChatOpenAI } from "@langchain/openai";
import { WikipediaQueryRun } from "@langchain/community/tools/wikipedia_query_run";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { DynamicTool } from "@langchain/core/tools";
import axios from "axios";
import { prisma } from "../db";
import { openWeatherToken } from "../config";
import { BotContext } from "../bot";
import { langfuseHandler } from "./langfuse";
import { openRouterToken } from "../config";

const geminiFlash2 = new ChatOpenAI({
  model: "google/gemini-2.0-flash-lite-001",
  apiKey: openRouterToken,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
  },
  temperature: 1,
});

const weatherTool = new DynamicTool({
  name: "get_weather",
  description: "Получить погоду для указанного места",
  func: async (location: string) => {
    try {
      const weatherResponse = await axios.get<any>(
        `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
          location
        )}&appid=${openWeatherToken}&lang=ru&units=metric`,
        { responseType: "json" }
      );
      return JSON.stringify(weatherResponse.data);
    } catch (error) {
      return "Не удалось получить информацию о погоде";
    }
  },
});

const greetingTool = new DynamicTool({
  name: "set_greeting",
  description: "Установить приветствие для нового пользователя в чате",
  func: async (input: string) => {
    try {
      const { chatId, userId, greeting, ctx } = JSON.parse(input) as {
        chatId: number;
        userId: number;
        greeting: string;
        ctx: BotContext;
      };

      const adminList = await ctx.api.getChatAdministrators(chatId);
      if (
        !adminList.some(
          (admin) =>
            (admin.status === "administrator" || admin.status === "creator") &&
            admin.user.id === userId
        )
      ) {
        return JSON.stringify({
          error: "Не хватает прав для установки приветствия",
        });
      }

      await prisma.chat.update({
        where: { id: BigInt(chatId) },
        data: { greeting },
      });

      return JSON.stringify({
        message: `Приветствие установлено: ${greeting}`,
      });
    } catch (error) {
      return JSON.stringify({ error: "Ошибка при установке приветствия" });
    }
  },
});

export const chatGeneration = async (messages: any[]) => {
  const chatAgent = createReactAgent({
    name: "chat-generation",
    llm: geminiFlash2,
    tools: [
      new WikipediaQueryRun({
        topKResults: 3,
        maxDocContentLength: 4000,
        baseUrl: "https://ru.wikipedia.org/w/api.php",
      }),
      weatherTool,
      greetingTool,
    ],
  });

  const result = await chatAgent.invoke(
    { messages },
    {
      callbacks: [langfuseHandler],
    }
  );

  return result.messages[result.messages.length - 1].content;
};
