import * as O from 'fp-ts/lib/Option';

export interface IUser {
  id: number;
  userName: O.Option<string>;
  isAdmin: boolean;
  canRestrictMembers: boolean;
}

export interface IExecuteProps {
  tokenList: string[];
  normalizedTokenList: string[];
  canRestrictMembers: boolean;
  replyUser: O.Option<IUser>;
  username: string;
  messageId: number;
}

