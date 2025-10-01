// Inktober Controller 

import { Composer } from "grammy";
import { prisma } from "../db";
import { sendInktoberMessage } from "../features/inktober";
import { BotContext } from "../bot"; // Импортируем BotContext

export const inktoberController = new Composer<BotContext>();

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

// Команда для включения Inktober
inktoberController.command("enable", async (ctx) => {
  const feature = ctx.match?.toLowerCase();
  if (feature !== "inktober") return;

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
      update: { inktoberEnabled: true },
      create: {
        id: BigInt(ctx.chat.id),
        title: ctx.chat.title || "Unknown Group",
        chatType: ctx.chat.type === "supergroup" ? "GROUP" : "GROUP",
        inktoberEnabled: true,
      },
    });
    await ctx.reply("Функция 'Inktober' включена для этого чата! 🎨");
  } catch (error) {
    console.error("Ошибка при включении Inktober:", error);
    await ctx.reply("Произошла ошибка при включении функции.");
  }
});

// Команда для выключения Inktober
inktoberController.command("disable", async (ctx) => {
  const feature = ctx.match?.toLowerCase();
  if (feature !== "inktober") return;

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
      data: { inktoberEnabled: false },
    });
    await ctx.reply("Функция 'Inktober' выключена для этого чата.");
  } catch (error: any) {
    if (error.code === 'P2025') {
      await ctx.reply("Функция 'Inktober' уже была выключена или чат не найден.");
    } else {
      console.error("Ошибка при выключении Inktober:", error);
      await ctx.reply("Произошла ошибка при выключении функции.");
    }
  }
});

// Команда для тестирования Inktober
inktoberController.command("test", async (ctx) => {
  const feature = ctx.match?.toLowerCase();
  if (feature !== "inktober") return;

  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Эту команду можно использовать только в группах.");
    return;
  }

  if (!(await isAdmin(ctx))) {
    await ctx.reply("Только администраторы могут тестировать эту функцию.");
    return;
  }

  try {
    await ctx.reply("Тестируем отправку сообщения 'Inktober'...");
    await sendInktoberMessage(ctx.chat.id);
  } catch (error) {
    console.error("Ошибка при тестовой отправке Inktober:", error);
    await ctx.reply("Произошла ошибка при тестировании функции.");
  }
});
