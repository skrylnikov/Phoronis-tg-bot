// Selfie Saturday Controller 

import { Composer } from "grammy";
import { prisma } from "../db";
import { sendSelfieSaturdayMessage } from "../features/selfie-saturday";
import { BotContext } from "../bot"; // Импортируем BotContext

export const selfieSaturdayController = new Composer<BotContext>();

// Вспомогательная функция для проверки прав администратора
async function isAdmin(ctx: BotContext): Promise<boolean> {
  if (!ctx.chat || ctx.chat.type === "private") {
    return false;
  }
  if (!ctx.from) {
    return false;
  }

  const member = await ctx.getChatMember(ctx.from.id);
  return ["administrator", "creator"].includes(member.status);
}

// Команда для включения Селфи Субботы
selfieSaturdayController.command("enable", async (ctx) => {
  const feature = ctx.match?.toLowerCase();
  if (feature !== "selfiesaturday") return;

  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Эту команду можно использовать только в группах.");
    return;
  }

  if (!(await isAdmin(ctx))) {
    await ctx.reply("Только администраторы могут включать эту функцию.");
    return;
  }

  try {
    await prisma.chat.upsert({
      where: { id: BigInt(ctx.chat.id) },
      update: { selfieSaturdayEnabled: true },
      create: {
        id: BigInt(ctx.chat.id),
        title: ctx.chat.title || "Unknown Group",
        chatType: ctx.chat.type === "supergroup" ? "GROUP" : "GROUP",
        selfieSaturdayEnabled: true,
      },
    });
    await ctx.reply("Функция 'Селфи Суббота' включена для этого чата! 🎉");
  } catch (error) {
    console.error("Ошибка при включении Селфи Субботы:", error);
    await ctx.reply("Произошла ошибка при включении функции.");
  }
});

// Команда для выключения Селфи Субботы
selfieSaturdayController.command("disable", async (ctx) => {
  const feature = ctx.match?.toLowerCase();
  if (feature !== "selfiesaturday") return;

  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Эту команду можно использовать только в группах.");
    return;
  }

  if (!(await isAdmin(ctx))) {
    await ctx.reply("Только администраторы могут выключать эту функцию.");
    return;
  }

  try {
    await prisma.chat.update({
      where: { id: BigInt(ctx.chat.id) },
      data: { selfieSaturdayEnabled: false },
    });
    await ctx.reply("Функция 'Селфи Суббота' выключена для этого чата.");
  } catch (error: any) {
    if (error.code === 'P2025') {
      await ctx.reply("Функция 'Селфи Суббота' уже была выключена или чат не найден.");
    } else {
      console.error("Ошибка при выключении Селфи Субботы:", error);
      await ctx.reply("Произошла ошибка при выключении функции.");
    }
  }
});

// Команда для тестирования Селфи Субботы
selfieSaturdayController.command("test", async (ctx) => {
  const feature = ctx.match?.toLowerCase();
  if (feature !== "selfiesaturday") return;

  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Эту команду можно использовать только в группах.");
    return;
  }

  if (!(await isAdmin(ctx))) {
    await ctx.reply("Только администраторы могут тестировать эту функцию.");
    return;
  }

  try {
    await ctx.reply("Тестируем отправку сообщения 'Селфи Суббота'...");
    await sendSelfieSaturdayMessage(ctx.chat.id);
  } catch (error) {
    console.error("Ошибка при тестовой отправке Селфи Субботы:", error);
    await ctx.reply("Произошла ошибка при тестировании функции.");
  }
}); 
