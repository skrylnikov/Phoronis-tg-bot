const historyQuestionMarkers = [
  'истори',
  'обсужд',
  'когда мы',
  'раньше',
  'вспомн',
  'помнишь',
  'кто писал',
  'кто говорил',
  'что было',
  'от меня',
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

export function isChatHistorySearchIntent(
  text: string | undefined,
  repliedText: string | undefined,
): boolean {
  return (
    containsMarker(text, historyQuestionMarkers) ||
    containsMarker(repliedText, historyReplyMarkers)
  );
}
