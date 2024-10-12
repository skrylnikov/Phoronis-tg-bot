import { Context } from 'grammy';

export interface IExecuteProps {
  tokenList: string[];
  normalizedTokenList: string[];
  ctx: Context;
  text: string;
  activationWord: string;
}