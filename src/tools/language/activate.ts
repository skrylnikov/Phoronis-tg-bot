import { curry } from 'ramda';

export const findActivate = curry((activateWordList: string[], tokenListList: string[][]) =>  tokenListList
  .find((tokenList) => activateWordList.some((token) => tokenList.includes(token)))
  ?.filter((token) => !activateWordList.includes(token))
);
