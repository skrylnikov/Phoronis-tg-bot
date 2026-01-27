import { Langfuse } from 'langfuse';
import { langfuseConfig } from '../config';

export const langfuse = new Langfuse(langfuseConfig);
