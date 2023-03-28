import { Context } from 'telegraf';

export interface IExecuteProps {
  tokenList: string[];
  normalizedTokenList: string[];
  ctx: Context;
  text: string;
}