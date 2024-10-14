export const findActivate =
  (activateWordList: string[]) => (tokenListList: string[][]) =>
    tokenListList
      .find((tokenList) =>
        activateWordList.some((token) => tokenList.includes(token))
      )
      ?.filter((token) => !activateWordList.includes(token));
