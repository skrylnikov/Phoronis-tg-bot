import { pipe } from 'fp-ts/lib/pipeable.js';
import * as O from 'fp-ts/lib/Option.js';
import * as E from 'fp-ts/lib/Either.js';
import natural from 'natural';

import { IExecuteProps, IUser } from './types.js';
import { IActionTypes, sendMessage, sendMessageWithDelay, deleteMessage, restrictUser } from './actions.js';

export const config = {
  activateList: [['бан'], ['забань']],
};

const { PorterStemmerRu } = natural;

const getResult = <T>(value: T | T[]): T[] => Array.isArray(value) ? value : [value];

const getRestrictTime = (tokenList: string[]): E.Either<string, number> => {
  const numberList = tokenList.map((x) => parseInt(x)).filter((x) => Number.isFinite(x));

  if (numberList.length === 0) {
    return E.right(40);
  }
  const number = numberList[0];

  const numberI = tokenList.indexOf(number.toString());

  if (numberList.length !== 1 || numberI === -1) {
    return E.left('Упс, не смогла разобрать на какое время нужно банить :(');
  }
  const nextWorldId = numberI + 1;
  if (nextWorldId >= tokenList.length) {
    return E.right(number);
  }

  const nextWorld = tokenList[nextWorldId];

  switch (nextWorld) {
    case PorterStemmerRu.stem('мин'):
    case PorterStemmerRu.stem('минут'): {
      return E.right(number * 60);
    }
    case PorterStemmerRu.stem('час'): {
      return E.right(number * 60 * 60);
    }
    case PorterStemmerRu.stem('дня'):
    case PorterStemmerRu.stem('дней'):
    case PorterStemmerRu.stem('день'): {
      return E.right(number * 60 * 60 * 24);
    }

    default:
      return E.right(number);
  }
};

const getUserName = (user: IUser) =>
  pipe(
    user.userName,
    O.fold(
      () => `[Неопознаный космонавт](tg://user?id=${user.id})`,
      (v) => '@' + v),
  );

export const execute = async ({ replyUser, canRestrictMembers, username, messageId, normalizedTokenList }: IExecuteProps): Promise<IActionTypes[]> =>
  pipe(
    replyUser,
    E.fromOption(() => 'Ой, кажется я не смогла найти кого тут нужно забанить :('),
    E.chain((user) => canRestrictMembers ? E.right(user) : E.left('Кажется ты не можешь банить участников :(')),
    E.chain((user) => !user.isAdmin ? E.right(user) : E.left('Ой, я не могу банить админов :(')),
    E.chain((user) => pipe(
      getRestrictTime(normalizedTokenList),
      E.map((value) => [
        sendMessage(`${username} забанил ${getUserName(user)} на ${value} секунд`),
        sendMessageWithDelay(`${getUserName(user)} разбанен :)`, value),
        deleteMessage(messageId),
        restrictUser(user.id, value),
      ]),
    )),

    E.mapLeft((v) => sendMessage(v, { reply: true })),

    E.fold(getResult, getResult),
  );