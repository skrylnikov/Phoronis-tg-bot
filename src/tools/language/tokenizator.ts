import { map, piped } from 'remeda';

export const sentenceTokenize = (text: string) =>
  text.toLowerCase().split(/\.|!|\?/);

export const wordTokenize = (text: string) =>
  text
    .toLowerCase()
    .split(/\s|\.|,|!|\?/)
    .filter((x) => x.length !== 0);

export const tokenize = piped(sentenceTokenize, map(wordTokenize));
