import { OpenAI } from "openai";
import axios from "axios";
import { Message, User } from "@prisma/client";
import { unique } from "remeda";
import MD from "telegramify-markdown";
import { logger } from "../logger";

import { openWeatherToken } from "../config";
import { BotContext } from "../bot";
import { openai } from "../openai";
import { prisma } from "../db";

const defaultMessagesCreate = () => {
  const isHelpful = Math.random() < 0.3;
  const isUseUsername = Math.random() < 0.2;
  const isInterests = Math.random() < 0.1;

  return {
    role: "system",
    content: `Ты умный помошник, женского пола, названа в честь ИО - спутника Юпитера или персонажа древнегреческой мифологии.
    Отвечай кратко и по делу. ${
      isHelpful ? "Будь полезной и старайся помочь." : ""
    }
    Отвечай в стиле собеседника. ${
      isInterests
        ? "Иногда предлагай пообщаться на интересные пользователю темы."
        : ""
    }
    ${
      isUseUsername
        ? "В ответах если это уместно, иногда используй имя собеседника."
        : ""
    }
    
    Ниже будет переписка из чата в формате JSON, ответь на последнее сообщение`,
  } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
};

const getThread = async (chatId: number, messageId: bigint | null) => {
  const result: Array<Message & { sender: User }> = [];
  while (messageId) {
    const messages = await prisma.message.findMany({
      where: {
        chatId,
        id: {
          gte: messageId,
        },
      },
      include: {
        sender: true,
      },
      take: 10,
    });

    if (messages.length === 0) {
      break;
    }
    let lastId: bigint | null = messageId;
    while (lastId) {
      const message = messages.find((x) => x.id === lastId);
      if (!message) {
        break;
      }
      result.push(message);
      lastId = message.replyToMessageId;
    }
    if (messageId === lastId) {
      break;
    }
    messageId = lastId;
  }

  result.reverse();

  return result;
};

export const aiController = async (ctx: BotContext, _text?: string) => {
  if (!ctx.msg?.text && !_text || !ctx.msg) {
    return;
  }
  await ctx.replyWithChatAction("typing");

  const text = _text || ctx.msg.text;

  const defaultMessages = defaultMessagesCreate();

  const messages = [{ ...defaultMessages }];

  let list: Awaited<ReturnType<typeof getThread>> = [];

  if (ctx.msg.reply_to_message) {
    list = await getThread(
      ctx.chatId!,
      BigInt(ctx.msg.reply_to_message.message_id)
    );
  }

  // Группируем последовательные сообщения
  let currentMessages: typeof list = [];
  let currentRole: "assistant" | "user" | null = null;

  const pushMessages = () => {
    if (currentMessages.length === 0) return;
    
    messages.push({
      role: currentRole!,
      content: [
        {
          type: "text",
          text: currentRole === 'assistant' ? currentMessages[0].summary || currentMessages[0].text! : JSON.stringify(
            currentMessages.map((msg) => ({
              // id: Number(msg.id),
              // replyToMessageId: msg.replyToMessageId
              //   ? Number(msg.replyToMessageId)
              //   : undefined,
              sender: msg.sender.userName,
              text: msg.summary || msg.text,
            }))
          ),
        },
      ],
    });
    currentMessages = [];
  };

  // Обрабатываем сообщения из истории
  list.forEach((msg) => {
    const role = msg.sender.userName === ctx.me.username ? "assistant" : "user";
    
    if (role !== currentRole) {
      pushMessages();
      currentRole = role;
    }
    
    currentMessages.push(msg);
  });
  
  // Добавляем оставшиеся сообщения из истории
  pushMessages();

  // Добавляем текущее сообщение пользователя
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: JSON.stringify([
          {
            // id: ctx.msg.message_id,
            // replyToMessageId: ctx.msg.reply_to_message?.message_id,
            sender: ctx.from?.username,
            text,
          },
        ]),
      },
    ],
  });

  const userList = await prisma.user.findMany({
    where: {
      userName: {
        in: unique([
          ctx.from?.username!,
          ...list.map((x) => x.sender.userName!),
          ctx.me.username,
        ]).filter(Boolean),
      },
    },
  });

  messages[0].content += `\nСписок пользователей:\n${JSON.stringify(
    userList.map((x) => ({
      // id: Number(x.id),
      firstName: x.firstName,
      lastName: x.lastName,
      userName: x.userName,
      metaInfo: x.metaInfo || {},
    }))
  )}`;

  const runner = openai.beta.chat.completions.runTools({
    model: "gpt-4o-mini",
    messages: messages,
    tools: [
      {
        type: "function",
        function: {
          name: "thinking",
          description: "Обработать запрос более умной llm. Вызывать в случае если пользователь попросил подумать, либо ты ошиблась в ответе",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Вопрос",
              },
            },
          },
          function: async (parameters: { query: string }) => {
            const completion = await openai.chat.completions.create({
              model: "o1-mini",
              messages: [
                {
                  role: "user",
                  content: parameters.query,
                },
              ],
            });

            const response = completion.choices[0].message.content;
            logger.debug(
              `Reasoning response for "${parameters.query}": ${response}`
            );

            return {
              reasoning: response,
            };
          },
          parse: JSON.parse,
        },
      },
      {
        type: "function",
        function: {
          name: "get_whether",
          description: "Get the weather for a location",
          parameters: {
            type: "object",
            properties: {
              location: {
                type: "string",
                description: "The location to get the weather for",
              },
            },
          },
          function: async (parameters: { location: string }) => {
            const weatherResponse = await axios.get<any>(
              `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
                parameters.location
              )}&appid=${openWeatherToken}&lang=ru&units=metric`,
              { responseType: "json" }
            );

            const weather = weatherResponse.data;

            return weather;
          },
          parse: JSON.parse,
        },
      },
      {
        type: "function",
        function: {
          name: "set_greeting",
          description: "Set a greeting for the new user in chat",
          parameters: {
            type: "object",
            properties: {
              greeting: {
                type: "string",
                description: "The greeting to set",
              },
            },
          },
          function: async (parameters: { greeting: string }) => {
            const adminList = await ctx.api.getChatAdministrators(ctx.chat!.id);
            if (
              !adminList
                .filter(
                  (x) => x.status === "administrator" || x.status === "creator"
                )
                .map((x) => x.user.id)
                .includes(ctx.from!.id)
            ) {
              return { error: "Не хватает прав для установки приветствия" };
            }

            await prisma.chat.update({
              where: {
                id: ctx.chat!.id,
              },
              data: {
                greeting: parameters.greeting,
              },
            });

            return {
              message: `Приветствие установлено: ${parameters.greeting}`,
            };
          },
          parse: JSON.parse,
        },
      },
    ],
  });

  const result = await runner.finalContent();

  logger.debug(
    `AI request for user ${JSON.stringify({
      ...userList[0],
      id: Number(userList[0].id),
    })} in chat ${JSON.stringify(ctx.chat)}: ${JSON.stringify(
      messages
    )} \n response: "${result}"`
  );

  if (result) {
    const reply = await ctx.reply(MD(result, "remove"), {
      reply_to_message_id: ctx.msg?.message_id,
      parse_mode: "MarkdownV2",
    });

    try {
      const replyToMessage = await prisma.message.findUnique({
        where: {
          chatId_id: {
            chatId: ctx.chatId!,
            id: ctx.msg?.message_id!,
          },
        },
        select: {
          id: true,
        },
      });

      await prisma.message.create({
        data: {
          id: reply.message_id,
          chatId: ctx.chatId!,
          senderId: reply.from!.id,
          replyToMessageId: replyToMessage ? replyToMessage.id : null,
          sentAt: new Date(reply.date * 1000),
          messageType: "TEXT",
          text: result,
        },
      });
    } catch (error) {
      logger.error(error);
      logger.debug({
        id: reply.message_id,
        chatId: ctx.chatId!,
        senderId: reply.from!.id,
        replyToMessageId: ctx.msg?.message_id,
        sentAt: new Date(reply.date * 1000),
        messageType: "TEXT",
        text: result,
      });
    }
  }
};
