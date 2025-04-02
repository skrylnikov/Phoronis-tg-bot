// import { OpenAI } from "openai";
import { Message, User } from "@prisma/client";
import { unique } from "remeda";
import MD from "telegramify-markdown";

import { logger } from "../logger";
import { BotContext } from "../bot";
import { prisma } from "../db";

import { langfuse } from "./langfuse";
import { chatGeneration } from "./chat-generation";
import { getTopUserMetaInfo } from "../tools/user/meta-analyzer";

import { sessionIdGenerator } from "../config";
import { format } from "date-fns";
const defaultMessagesCreate = () => {
  const isHelpful = Math.random() < 0.3;
  const isUseUsername = Math.random() < 0.2;
  const isInterests = Math.random() < 0.1;
  const isShort = Math.random() < 0.5;
  const isFunny = !isHelpful && Math.random() < 0.1;

  return {
    role: "system",
    content: `Ты умный помошник, женского пола, названа в честь ИО - спутника Юпитера или персонажа древнегреческой мифологии.
    ${isShort ? "Отвечай кратко." : ""}  ${
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
    ${isFunny ? "Отвечай с саркастическим юмором." : ""}
    Не используй эмодзи.
    Ниже будет переписка из чата в формате JSON, ответь на последнее сообщение. Ответ должен быть строкой, не JSON.`,
  } as any;
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

const getThreadBySessionId = async (
  chatId: number,
  messageId: bigint | null,
  sessionId: string
) => {
  const result: Array<Message & { sender: User }> = [];
  const messages = await prisma.message.findMany({
    where: {
      chatId,
      sessionId,
    },
    include: {
      sender: true,
    },
    take: 10,
  });

  let lastId: bigint | null = messageId;
  while (lastId) {
    const message = messages.find((x) => x.id === lastId);
    if (!message) {
      break;
    }
    result.push(message);
    lastId = message.replyToMessageId;
  }

  result.reverse();

  return result;
};

export const aiController = async (
  ctx: BotContext,
  imageDescription?: string
) => {
  console.log(ctx.msg);
  if (!ctx.msg?.text && !ctx.msg?.caption) {
    return;
  }

  const typingInterval = setInterval(async () => {
    await ctx.replyWithChatAction("typing");
  }, 5000);

  try {
    await ctx.replyWithChatAction("typing");

    const text = ctx.msg.text || ctx.msg.caption;

    // const defaultMessages = defaultMessagesCreate();

    const rawMessages: ReturnType<typeof defaultMessagesCreate>[] = [];

    let list: Awaited<ReturnType<typeof getThread>> = [];

    const replyToMessage = await prisma.message.findUnique({
      where: {
        chatId_id: {
          chatId: ctx.chatId!,
          id: ctx.msg?.message_id!,
        },
      },
      select: {
        id: true,
        sessionId: true,
      },
    });

    const sessionId = replyToMessage?.sessionId || sessionIdGenerator();

    if (ctx.msg.reply_to_message) {
      if (replyToMessage?.sessionId) {
        list = await getThreadBySessionId(
          ctx.chatId!,
          BigInt(ctx.msg.reply_to_message.message_id),
          replyToMessage.sessionId
        );
      } else {
        list = await getThread(
          ctx.chatId!,
          BigInt(ctx.msg.reply_to_message.message_id)
        );
      }
    }

    // Группируем последовательные сообщения
    let currentMessages: typeof list = [];
    let currentRole: "assistant" | "user" | null = null;

    const pushMessages = () => {
      if (currentMessages.length === 0) return;

      if (currentRole === "assistant") {
        rawMessages.push({
          role: currentRole!,
          content: currentMessages[0].summary || currentMessages[0].text!,
        });
      } else {
        rawMessages.push({
          role: currentRole!,
          content: JSON.stringify(
            currentMessages.map((msg) => ({
              type: msg.messageType,
              sender: msg.sender.userName,
              text:
                (msg.messageType === "MEDIA"
                  ? "Пользователь прислал фотографию, описание которой: "
                  : "") + (msg.summary || msg.text),
            }))
          ),
        });
      }

      currentMessages = [];
    };

    // Обрабатываем сообщения из истории
    list.forEach((msg) => {
      const role =
        msg.sender.userName === ctx.me.username ? "assistant" : "user";

      if (role !== currentRole) {
        pushMessages();
        currentRole = role;
      }

      currentMessages.push(msg);
    });

    // Добавляем оставшиеся сообщения из истории
    pushMessages();

    // Добавляем текущее сообщение пользователя
    rawMessages.push({
      role: "user",
      content: JSON.stringify([
        ...(imageDescription
          ? [
              {
                type: "image",
                sender: ctx.from?.username,
                image:
                  "Пользователь прислал фотографию, описание которой: " +
                  imageDescription,
              },
            ]
          : []),
        {
          type: "text",
          sender: ctx.from?.username,
          text,
        },
      ]),
    });

    const userList = await prisma.user.findMany({
      where: {
        userName: {
          in: unique([
            ctx.from?.username!,
            ...list.map((x) => x.sender.userName!),
          ]).filter(Boolean),
        },
      },
    });

    const prompt = await langfuse.getPrompt("chat-generation");

    const trace = langfuse.trace({
      name: "chat-generation",
      sessionId,
      userId: ctx.from?.id?.toString() || null,
      metadata: {
        userName: [
          ctx.from?.username ? "@" + ctx.from?.username : null,
          ctx.from?.first_name,
          ctx.from?.last_name,
        ]
          .filter(Boolean)
          .join(" "),
      },
    });

    // const isHelpful = Math.random() < 0.3;
    const isHelpful = false;
    const isUseUsername = Math.random() < 0.2;
    const isInterests = Math.random() < 0.1;
    const isShort = Math.random() < 0.5;
    // const isFunny = !isHelpful && Math.random() < 0.1;
    const isFunny = true;

    const compiledPrompt = prompt.compile({
      users: JSON.stringify(
        userList.map((x) => ({
          firstName: x.firstName,
          lastName: x.lastName,
          userName: x.userName,
          metaInfo: getTopUserMetaInfo(x.metaInfo),
        }))
      ),
      rules: [
        "- Используй tools когда это нужно",
        isShort && "- Отвечай кратко",
        isHelpful && "- Будь полезной и старайся помочь",
        isInterests &&
          "- Иногда предлагай пообщаться на интересные пользователю темы",
        isUseUsername &&
          "- В ответах если это уместно, иногда используй имя собеседника",
        isFunny && "- Отвечай с саркастическим юмором",
      ]
        .filter(Boolean)
        .join("\n"),

      time: format(new Date(), "dd.MM.yyyy HH:mm:ss"),
    });

    console.log(compiledPrompt);

    const messages = [
      {
        role: "system",
        content: compiledPrompt,
      },
      ...rawMessages,
    ];

    const result = await chatGeneration(messages, trace);

    console.info(result);

    logger.debug(
      `AI request for user ${JSON.stringify({
        ...userList[0],
        id: Number(userList[0].id),
      })} in chat ${JSON.stringify(ctx.chat)}: ${JSON.stringify(
        rawMessages
      )} \n response: "${result}"`
    );

    if (result) {
      clearInterval(typingInterval);
      const reply = await ctx.reply(MD(result.toString(), "remove"), {
        reply_to_message_id: ctx.msg?.message_id,
        parse_mode: "MarkdownV2",
      });

      try {
        await prisma.message.create({
          data: {
            id: reply.message_id,
            chatId: ctx.chatId!,
            senderId: reply.from!.id,
            replyToMessageId: replyToMessage ? replyToMessage.id : null,
            sentAt: new Date(reply.date * 1000),
            messageType: "TEXT",
            text: result.toString(),
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
          text: result.toString(),
        });
      }
    }
  } catch (error) {
    logger.error(error);
  }

  clearInterval(typingInterval);
};
