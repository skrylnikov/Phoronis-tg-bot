import { pipe, without, flatten } from 'ramda';
import natural from 'natural';
import * as O from 'fp-ts/lib/Option.js';
import { addSeconds } from 'date-fns';
import { Language } from '../../tools/index.js';
import { activateWordList } from '../../config.js';
import * as Weather from './weather.js';
import * as Translate from './translate.js';
import { askAI } from './ai.js';
import { Actions } from '../../bl/actions.js';
import * as About from '../../bl/about.js';
import * as Ping from '../../bl/ping.js';
import * as Restriction from '../../bl/restriction.js';
const { PorterStemmerRu } = natural;
const rawConfig = [
    Weather,
    About,
    Ping,
    Restriction,
    Translate,
];
const executorList = rawConfig.map((c) => ({
    ...c,
    config: {
        ...c.config,
        activateTokenList: c.config.activateList.map((x) => x.map(PorterStemmerRu.stem)),
    },
}));
console.log(executorList);
export const processTextMessage = async (ctx) => {
    console.log('processTextMessage');
    const text = ctx.message?.text;
    if (!text || !ctx.from || !ctx.message) {
        return;
    }
    const tokenList = pipe(Language.clean, Language.tokenize, Language.findActivate(activateWordList))(text);
    if (!tokenList || tokenList.length === 0) {
        return;
    }
    const normalizedTokenList = tokenList.map(PorterStemmerRu.stem);
    console.log(normalizedTokenList);
    const comand = executorList.find((x) => x.config.activateTokenList.some((x) => x.every((y) => normalizedTokenList.includes(y))));
    if (!comand) {
        if (text.endsWith('?')) {
            ctx.replyWithChatAction('typing');
            const result = await askAI(text);
            if (result) {
                ctx.reply(result, { reply_to_message_id: ctx.message?.message_id });
                return;
            }
        }
        ctx.reply('Я тут', { reply_to_message_id: ctx.message?.message_id });
        return;
    }
    const replyUser = ctx.message?.reply_to_message?.from?.id ? {
        id: ctx.message.reply_to_message.from.id,
        userName: O.fromNullable(ctx.message.reply_to_message.from.username),
        isAdmin: false,
        canRestrictMembers: false,
    } : null;
    let canRestrictMembers = false;
    if (ctx.chat) {
        try {
            const adminList = await ctx.telegram.getChatAdministrators(ctx.chat.id);
            canRestrictMembers = adminList
                .filter((x) => x.can_restrict_members || x.status === 'creator')
                .map((x) => x.user.id)
                .includes(ctx.from.id);
            if (replyUser) {
                replyUser.isAdmin = adminList.map((x) => x.user.id).includes(replyUser.id);
            }
        }
        catch (e) {
            console.error(e);
        }
    }
    const username = '@' + ctx.from.username;
    const [result] = await Promise.all([
        comand.execute({
            tokenList,
            normalizedTokenList: without(flatten(comand.config.activateTokenList), normalizedTokenList),
            replyUser: O.fromNullable(replyUser),
            canRestrictMembers,
            username,
            messageId: ctx.message.message_id,
            ctx,
        }),
        ctx.replyWithChatAction('typing'),
    ]);
    result.forEach((action) => {
        switch (action.type) {
            case Actions.sendMessage: {
                ctx.reply(action.payload, {
                    reply_to_message_id: action.meta?.reply ? ctx.message?.message_id : undefined,
                    parse_mode: 'Markdown',
                });
                return;
            }
            case Actions.sendMessageWithDelay: {
                setTimeout(() => {
                    try {
                        ctx.reply(action.payload, { parse_mode: 'Markdown', });
                    }
                    catch (e) {
                        console.error(e);
                    }
                }, action.meta * 1000);
                return;
            }
            case Actions.deleteMessage: {
                ctx.deleteMessage(action.payload);
                return;
            }
            case Actions.restrictUser: {
                ctx.restrictChatMember(action.payload, {
                    permissions: {},
                    until_date: addSeconds(new Date(), action.meta).getTime() / 1000,
                });
                return;
            }
        }
    });
};
