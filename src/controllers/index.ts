import { Composer } from "grammy";

import { BotContext } from '../bot'

import { processMessageController } from "./process-message.js";
import { startController } from "./start.js";
import { newChatMembersController } from "./new-chat-members.js";
import { meController } from "./me.js";
import { voiceController } from "./voice.js";
import { selfieSaturdayController } from "./selfie-saturday";

export const controllers = new Composer<BotContext>();

controllers.command("start", startController);

controllers.command("me", meController);

controllers.use(selfieSaturdayController);

controllers.on(":voice", voiceController);
controllers.on(":video_note", voiceController);

controllers.on(":new_chat_members", newChatMembersController);

controllers.use(processMessageController);
