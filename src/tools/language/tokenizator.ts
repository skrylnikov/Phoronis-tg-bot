import { pipe, map } from 'ramda';

export const sentenceTokenize = (text: string) => text
  .toLowerCase()
  .split(/\.|!|\?/);

export const wordTokenize = (text: string) => text
  .toLowerCase()
  .split(/\s|\.|,|!|\?|[0-9]/)
  .filter((x) => x.length !== 0);

export const tokenize = pipe(
  sentenceTokenize,
  map(wordTokenize),
);
