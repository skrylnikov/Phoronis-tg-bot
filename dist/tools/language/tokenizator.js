import { pipe, map } from 'ramda';
export const sentenceTokenize = (text) => text
    .toLowerCase()
    .split(/\.|!|\?/);
export const wordTokenize = (text) => text
    .toLowerCase()
    .split(/\s|\.|,|!|\?/)
    .filter((x) => x.length !== 0);
export const tokenize = pipe(sentenceTokenize, map(wordTokenize));
