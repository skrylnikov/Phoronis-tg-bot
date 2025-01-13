import { OpenAI } from "openai";
import axios from "axios";
import { Message, User } from "@prisma/client";
import { unique } from "remeda";
import MD from 'telegramify-markdown'

import { openWeatherToken } from "../config";
import { BotContext } from "../bot";
import { openai } from "../openai";
import { prisma } from "../db";

const defaultMessages = {
  role: "system",
  content:
    `Ты умный помошник, женского пола, названа в честь ИО - спутника Юпитера или персонажа древнегреческой мифологии.
    Отвечай кратко и по делу. Будь полезной и старайся помочь.
    Отвечай в стиле собеседника, если захочешь предложи пообщаться на интересные пользователю темы.
    В ответах если это уместно, иногда используй имя собеседника.
    
    Ниже будет переписка из чата в формате JSON, ответь на последнее сообщение`,
} as OpenAI.Chat.Completions.ChatCompletionMessageParam;

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

export const aiController = async (ctx: BotContext) => {
  if (!ctx.msg?.text) {
    return;
  }
  await ctx.replyWithChatAction("typing");

  const text = ctx.msg.text;

  const messages = [{ ...defaultMessages }];

  let list: Awaited<ReturnType<typeof getThread>> = [];

  if (ctx.msg.reply_to_message) {
    list = await getThread(
      ctx.chatId!,
      BigInt(ctx.msg.reply_to_message.message_id)
    );
  }

  const photos = list
    .filter((x) => x.media)
    .flatMap((x) => JSON.parse(x.media!))
    .map((x) => ({type: 'image_url' as const, image_url: {
      url: x,
    }}));

  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: JSON.stringify([
          ...list.map((x) => ({
            id: Number(x.id),
            replyToMessageId: x.replyToMessageId
              ? Number(x.replyToMessageId)
              : undefined,
            sender: x.sender.userName,
            text: x.text,
          })),
          {
            id: ctx.msg.message_id,
            replyToMessageId: ctx.msg.reply_to_message?.message_id,
            sender: ctx.from?.username,
            text: ctx.msg.text,
          },
        ]),
      },
      ...photos,
    ],
  });

  //   messages.push(
  //     ...list.map((msg) => ({
  //       role:
  //         msg.senderId === BigInt(ctx.me.id)
  //           ? ("assistant" as const)
  //           : ("user" as const),
  //       content: msg.summary || msg.text!,

  //       ...(msg.senderId === BigInt(ctx.me.id)
  //         ? ({
  //             name: msg.sender.userName,
  //           } as any)
  //         : {}),
  //     }))
  //   );
  // }

  // messages.push({
  //   role: "user",
  //   content: text,
  //   name: ctx.from?.username,
  // });

  const userList = await prisma.user.findMany({
    where: {
      userName: {
        in: unique([
          ...list.map((x) => x.sender.userName!),
          ctx.me.username,
          ctx.from?.username!,
        ]),
      },
    },
  });

  messages[0].content += `\nСписок пользователей:\n${JSON.stringify(
    userList.map((x) => ({
      id: Number(x.id),
      firstName: x.firstName,
      lastName: x.lastName,
      userName: x.userName,
      metaInfo: x.metaInfo || {}
    }))
  )}`;

  console.log(messages);

  const runner = openai.beta.chat.completions.runTools({
    model: "gpt-4o-mini",
    messages: messages,
    tools: [
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

  console.log(result);

  if (result) {
    const reply = await ctx.reply(MD(result, 'remove'), {
      reply_to_message_id: ctx.message?.message_id,
      parse_mode: "MarkdownV2",
    });

    await prisma.message.create({
      data: {
        id: reply.message_id,
        chatId: ctx.chatId!,
        senderId: reply.from!.id,
        replyToMessageId: ctx.msg?.message_id,
        sentAt: new Date(reply.date * 1000),
        messageType: "TEXT",
        text: result,
      },
    });
  }
};
