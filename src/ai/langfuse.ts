import { Langfuse } from 'langfuse';
import { CallbackHandler } from 'langfuse-langchain';
import { langfuseConfig } from '../config';

export const langfuse = new Langfuse(langfuseConfig);

export const langfuseHandler = new CallbackHandler(langfuseConfig);
