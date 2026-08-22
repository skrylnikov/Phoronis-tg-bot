export const sentenceTokenize = (text: string) =>
  text.toLowerCase().split(/\.|!|\?/);

export const wordTokenize = (text: string) =>
  text
    .toLowerCase()
    .split(/\s|\.|,|!|\?/)
    .filter((x) => x.length !== 0);

export const tokenize = (text: string) => sentenceTokenize(text).map(wordTokenize);
