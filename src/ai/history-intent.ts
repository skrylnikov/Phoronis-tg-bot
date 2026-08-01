const historyQuestionMarkers = [
  'истори',
  'обсужд',
  'когда мы',
  'раньше',
  'вспомн',
  'помнишь',
  'кто писал',
  'кто говорил',
  'что писали',
  'что говорили',
  'что было',
  'что чат думает',
  'что думает чат',
  'от меня',
];

const explicitHistorySearchMarkers = [
  'поищи по чату',
  'поищи в чате',
  'поищи по истории',
  'найди в чате',
  'найди по истории',
];

const chatContextMarkers = [
  'в чате',
  'по чату',
  'в переписке',
  'среди участников',
];

const chatQuestionMarkers = [
  'кто',
  'что',
  'где',
  'когда',
  'какой',
  'какая',
  'какие',
  'расскажи',
  'есть ли',
];

const historyReplyMarkers = [
  'истори',
  'обсужд',
  'не виж',
  'не наш',
  'было:',
  'найден',
];

function containsMarker(text: string | undefined, markers: string[]): boolean {
  if (!text) return false;

  const normalized = text.toLocaleLowerCase('ru-RU');
  return markers.some((marker) => normalized.includes(marker));
}

export function isGenericHistorySearchRequest(
  text: string | undefined,
): boolean {
  if (!text) return false;

  const normalized = text.trim().toLocaleLowerCase('ru-RU');
  return (
    explicitHistorySearchMarkers.some((marker) =>
      normalized.includes(marker),
    ) ||
    normalized === 'поищи' ||
    normalized === 'найди' ||
    normalized === 'поиск по чату'
  );
}

export function isChatHistorySearchIntent(
  text: string | undefined,
  repliedText: string | undefined,
): boolean {
  return (
    containsMarker(text, historyQuestionMarkers) ||
    isGenericHistorySearchRequest(text) ||
    (containsMarker(text, chatContextMarkers) &&
      containsMarker(text, chatQuestionMarkers)) ||
    containsMarker(repliedText, historyReplyMarkers)
  );
}
