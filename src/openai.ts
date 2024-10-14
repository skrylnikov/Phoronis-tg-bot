import { OpenAI } from "openai";

import { openAIToken } from "./config";

export const openai = new OpenAI({ apiKey: openAIToken });
