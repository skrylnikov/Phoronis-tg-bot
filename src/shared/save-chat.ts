import { Chat } from "@grammyjs/types";
import { LRUCache } from "lru-cache";

import { prisma } from "../db";

const cache = new LRUCache<number, true>({
  max: 1000,
  ttl: 24 * 60 * 60 * 1000,
  updateAgeOnGet: false,
  updateAgeOnHas: false,
});

export const saveChat = async (
  chat:
    | Chat.PrivateChat
    | Chat.GroupChat
    | Chat.SupergroupChat
    | Chat.ChannelChat
) => {
  if (cache.has(chat.id)) {
    return;
  }
  const chatType = chat.type === "private" ? "PRIVATE" : "GROUP";

  const title =
    chat.type === "private"
      ? [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
        chat.username ||
        chat.id.toString()
      : chat.title;

  await prisma.chat.upsert({
    create: {
      id: chat.id,
      title,
      chatType,
    },
    update: {
      title,
    },
    where: {
      id: chat.id,
    },
  });

  cache.set(chat.id, true);
};
