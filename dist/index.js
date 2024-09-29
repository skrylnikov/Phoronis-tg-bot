import Telegraf from "telegraf";
import { token } from "./config.js";
import { processMessageController, startController, newChatMembersController, meController, voiceController, } from "./controllers/index.js";
const bot = new Telegraf(token);
bot.start(startController);
bot.command("/me", meController);
bot.on("voice", voiceController);
bot.on("video_note", voiceController);
bot.on("new_chat_members", newChatMembersController);
bot.on("message", processMessageController);
bot
    .launch()
    .catch((e) => console.error(e));
bot.catch((e) => console.error(e));
process.on("uncaughtException", function (err) {
    console.log("Caught exception: " + err);
});
process.on("unhandledRejection", function (err) {
    console.log("Caught rejection: " + err);
});
