import type { ModelMessage } from 'ai';
import { generateText } from 'ai';
import type {
  AiThreadContextEventKind,
  Prisma,
} from '../generated/prisma/client';
import { logger } from '../logger';
import {
  appendAiThreadEventsRepo,
  commitAiThreadCacheBoundaryRepo,
  ensureAiThreadContextRepo,
  getAiThreadContextRepo,
} from '../repositories/ai-thread-context-repository';
import { currentUpdateAbortSignal } from '../update-signal';
import { utilityModel } from './ai';
import {
  buildChatGenerationInstructions,
  getLocalPromptMetadata,
  renderLocalPrompt,
} from './local-prompts';

export interface ChatGenerationRules {
  short: boolean;
  helpful: boolean;
  interests: boolean;
  username: boolean;
  funny: boolean;
}

export interface AiThreadContextInput {
  threadId: string;
  chatId: bigint;
  rootMessageId?: bigint;
  turnId: string;
  rules: string;
  userContext: unknown;
  retrievalContext?: unknown;
  time: string;
  currentUserMessage: ModelMessage;
  legacyHistory?: ModelMessage[];
  messageId?: bigint;
  privateMode?: boolean;
}

export interface AiThreadTelemetry {
  promptVersion: number;
  promptHash: string;
  threadId: string;
  cacheBoundary: number;
  stablePrefixCharacters: number;
  dynamicCharacters: number;
  providerCacheRead: number | 'unavailable';
  providerCacheWrite: number | 'unavailable';
}

interface ContextEvent {
  sequence: number;
  eventKind: AiThreadContextEventKind;
  payload: unknown;
}

const contextEventKinds = new Set<AiThreadContextEventKind>([
  'INITIAL_CONTEXT',
  'RETRIEVAL',
  'USER_CONTEXT',
  'TURN_CONTEXT',
  'CORRECTION',
  'CACHE_BOUNDARY',
]);
const userContextEventKinds = new Set<AiThreadContextEventKind>([
  'INITIAL_CONTEXT',
  'USER_CONTEXT',
  'CORRECTION',
]);
const compactAtCharacters = 48_000;

interface CompactionUserContext {
  event: AiThreadContextEventKind;
  data: unknown;
}

interface CompactionSnapshot {
  summary: string;
  userContexts: CompactionUserContext[];
  tailMessages: ModelMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function asJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isEmptyContext(value: unknown): boolean {
  return value === undefined || stableJson(value) === '{}';
}

function latestPayload(
  events: ContextEvent[],
  kinds: Set<AiThreadContextEventKind>,
): unknown {
  return [...events].reverse().find((event) => kinds.has(event.eventKind))
    ?.payload;
}

function hasFactCorrection(previous: unknown, current: unknown): boolean {
  if (!isRecord(previous) || !isRecord(current)) return false;
  const previousUsers = Array.isArray(previous.users) ? previous.users : [];
  const currentUsers = Array.isArray(current.users) ? current.users : [];
  const previousById = new Map(
    previousUsers.filter(isRecord).map((user) => [String(user.id), user]),
  );
  return currentUsers.some((candidate) => {
    if (!isRecord(candidate)) return false;
    const prior = previousById.get(String(candidate.id));
    return (
      prior !== undefined &&
      stableJson(prior.metaInfo) !== stableJson(candidate.metaInfo)
    );
  });
}

function contextMessage(event: ContextEvent): ModelMessage {
  return {
    role: 'user',
    content: JSON.stringify({
      type: 'ai-context',
      event: event.eventKind,
      sequence: event.sequence,
      data: event.payload,
    }),
  };
}

function messagesAfterBoundary(events: ContextEvent[]): ModelMessage[] {
  const lastBoundary = events.findLastIndex(
    (event) => event.eventKind === 'CACHE_BOUNDARY',
  );
  const activeEvents =
    lastBoundary >= 0 ? events.slice(lastBoundary + 1) : events;

  return activeEvents.flatMap((event) => {
    if (event.eventKind === 'LEGACY_HISTORY') {
      const messages = isRecord(event.payload) ? event.payload.messages : null;
      return Array.isArray(messages)
        ? (messages as ModelMessage[]).filter(
            (message) => message.role !== 'system',
          )
        : [];
    }

    if (event.eventKind !== 'USER_MESSAGE' && event.eventKind !== 'ASSISTANT') {
      return [];
    }
    if (!isRecord(event.payload)) return [];
    const content = event.payload.content;
    if (typeof content !== 'string' && !Array.isArray(content)) return [];

    return [
      {
        role: event.eventKind === 'ASSISTANT' ? 'assistant' : 'user',
        content,
      } as ModelMessage,
    ];
  });
}

function getCompactionSummary(events: ContextEvent[]): string | null {
  const boundary = [...events]
    .reverse()
    .find((event) => event.eventKind === 'CACHE_BOUNDARY');
  if (!boundary || !isRecord(boundary.payload)) return null;
  return typeof boundary.payload.summary === 'string'
    ? boundary.payload.summary
    : null;
}

function getCompactionTail(value: unknown): ModelMessage[] {
  if (!isRecord(value) || !Array.isArray(value.tailMessages)) return [];

  return value.tailMessages.filter((message): message is ModelMessage => {
    if (!isRecord(message)) return false;
    if (message.role !== 'user' && message.role !== 'assistant') return false;
    return (
      typeof message.content === 'string' || Array.isArray(message.content)
    );
  });
}

function getLegacyBoundaryMessages(events: ContextEvent[]): ModelMessage[] {
  const boundary = [...events]
    .reverse()
    .find((event) => event.eventKind === 'CACHE_BOUNDARY');
  if (!boundary || !isRecord(boundary.payload)) return [];
  if (typeof boundary.payload.summary === 'string') return [];
  if (!Array.isArray(boundary.payload.messages)) return [];

  return boundary.payload.messages.filter(
    (message): message is ModelMessage => {
      if (!isRecord(message)) return false;
      if (message.role !== 'user' && message.role !== 'assistant') return false;
      return (
        typeof message.content === 'string' || Array.isArray(message.content)
      );
    },
  );
}

function getCompactionUserContexts(value: unknown): CompactionUserContext[] {
  if (!isRecord(value)) return [];
  const rawContexts = Array.isArray(value.userContexts)
    ? value.userContexts
    : value.contexts;
  if (!Array.isArray(rawContexts)) return [];

  return rawContexts.flatMap((item) => {
    if (!isRecord(item) || typeof item.event !== 'string') return [];
    const event = item.event as AiThreadContextEventKind;
    if (!userContextEventKinds.has(event) || !('data' in item)) return [];
    return [{ event, data: item.data }];
  });
}

function collectUserContexts(events: ContextEvent[]): CompactionUserContext[] {
  const result: CompactionUserContext[] = [];
  const seen = new Set<string>();
  const append = (context: CompactionUserContext) => {
    const key = stableJson(context);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(context);
  };

  for (const event of events) {
    if (event.eventKind === 'CACHE_BOUNDARY') {
      for (const context of getCompactionUserContexts(event.payload)) {
        append(context);
      }
    } else if (userContextEventKinds.has(event.eventKind)) {
      append({ event: event.eventKind, data: event.payload ?? null });
    }
  }

  return result;
}

function eventMessages(events: ContextEvent[]): ModelMessage[] {
  const lastBoundary = events.findLastIndex(
    (event) => event.eventKind === 'CACHE_BOUNDARY',
  );
  const activeEvents = lastBoundary >= 0 ? events.slice(lastBoundary) : events;

  return activeEvents.flatMap((event) => {
    if (event.eventKind === 'CACHE_BOUNDARY') {
      return [contextMessage(event), ...getCompactionTail(event.payload)];
    }

    if (contextEventKinds.has(event.eventKind)) {
      return [contextMessage(event)];
    }

    if (event.eventKind === 'LEGACY_HISTORY') {
      const messages = isRecord(event.payload) ? event.payload.messages : null;
      return Array.isArray(messages)
        ? (messages as ModelMessage[]).filter(
            (message) => message.role !== 'system',
          )
        : [];
    }

    if (!isRecord(event.payload)) return [];
    const content = event.payload.content;
    if (typeof content !== 'string' && !Array.isArray(content)) return [];

    return [
      {
        role: event.eventKind === 'ASSISTANT' ? 'assistant' : 'user',
        content,
      } as ModelMessage,
    ];
  });
}

async function summarizeConversation(events: ContextEvent[]): Promise<string> {
  const messages = [
    ...getLegacyBoundaryMessages(events),
    ...messagesAfterBoundary(events),
  ];
  const previousSummary = getCompactionSummary(events);
  if (messages.length === 0) return previousSummary ?? '';

  const response = await generateText({
    abortSignal: currentUpdateAbortSignal(),
    model: utilityModel,
    instructions: renderLocalPrompt('context-compaction', {}),
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          previousSummary,
          messages,
        }),
      },
    ],
    temperature: 0,
    maxOutputTokens: 1_200,
  });
  const summary = response.text.trim();
  if (!summary) throw new Error('Context compaction returned an empty summary');
  return summary;
}

async function compactSnapshot(
  events: ContextEvent[],
): Promise<Prisma.InputJsonValue> {
  const summary = await summarizeConversation(events);
  const messages = messagesAfterBoundary(events);
  const lastMessage = messages.at(-1);
  return asJsonValue({
    summary,
    userContexts: collectUserContexts(events),
    tailMessages: lastMessage?.role === 'user' ? [lastMessage] : [],
  } satisfies CompactionSnapshot);
}

async function maybeCompact(
  threadId: string,
  cacheBoundary: number,
  events: ContextEvent[],
): Promise<{ events: ContextEvent[]; cacheBoundary: number }> {
  const characters = stableJson(eventMessages(events)).length;
  if (characters < compactAtCharacters) {
    return { events, cacheBoundary };
  }

  const nextBoundary = cacheBoundary + 1;
  try {
    const payload = await compactSnapshot(events);
    await commitAiThreadCacheBoundaryRepo(
      threadId,
      nextBoundary,
      events.at(-1)?.sequence ?? 0,
      payload,
    );
    const updated = await getAiThreadContextRepo(threadId);
    const payloadRecord: unknown = payload;
    logger.info(
      {
        event: 'ai.context_cache_boundary_created',
        threadId,
        cacheBoundary: nextBoundary,
        previousCharacters: characters,
        summaryCharacters:
          isRecord(payloadRecord) && typeof payloadRecord.summary === 'string'
            ? payloadRecord.summary.length
            : 0,
        preservedUserContextCount:
          isRecord(payloadRecord) && Array.isArray(payloadRecord.userContexts)
            ? payloadRecord.userContexts.length
            : 0,
      },
      'AI context cache boundary created',
    );
    return {
      events: (updated?.events ?? []) as ContextEvent[],
      cacheBoundary: updated?.cacheBoundary ?? nextBoundary,
    };
  } catch (error) {
    logger.error(
      {
        event: 'ai.context_compaction_failed',
        threadId,
        cacheBoundary,
        previousCharacters: characters,
        err: error,
      },
      'AI context compaction failed; keeping the full context',
    );
    return { events, cacheBoundary };
  }
}

export function chooseChatGenerationRules(
  random: () => number = Math.random,
): ChatGenerationRules {
  const helpful = random() < 0.3;
  return {
    short: random() < 0.5,
    helpful,
    interests: random() < 0.1,
    username: random() < 0.2,
    funny: !helpful && random() < 0.1,
  };
}

export function renderChatGenerationRules(
  rules: ChatGenerationRules,
  additionalRules: string[] = [],
): string {
  return [
    '- Используй tools когда это нужно',
    rules.short && '- Отвечай кратко',
    rules.helpful && '- Будь полезной и старайся помочь',
    rules.interests &&
      '- Иногда предлагай пообщаться на интересные пользователю темы',
    rules.username &&
      '- В ответах если это уместно, иногда используй имя собеседника',
    rules.funny && '- Отвечай с саркастическим юмором',
    ...additionalRules,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatAiContextTime(date = new Date()): string {
  return date
    .toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    .replace(',', '');
}

export function serializeAiThreadEvents(
  events: ContextEvent[],
): ModelMessage[] {
  return eventMessages(events);
}

export async function buildAiThreadContext(
  input: AiThreadContextInput,
): Promise<{
  instructions: string;
  messages: ModelMessage[];
  telemetry: AiThreadTelemetry;
}> {
  const prompt = getLocalPromptMetadata('chat-generation');
  const thread = await ensureAiThreadContextRepo({
    id: input.threadId,
    chatId: input.chatId,
    rootMessageId: input.rootMessageId,
    promptVersion: prompt.version,
    promptHash: prompt.hash,
    rules: input.rules,
  });
  const currentPrivateMessage =
    input.privateMode && input.messageId
      ? { chatId: input.chatId, messageId: input.messageId }
      : undefined;
  let stored = await getAiThreadContextRepo(
    input.threadId,
    currentPrivateMessage,
  );
  let events = (stored?.events ?? []) as ContextEvent[];
  const storedRules =
    typeof thread.rules === 'string' ? thread.rules : input.rules;
  const privateEventLink = currentPrivateMessage
    ? {
        messageChatId: currentPrivateMessage.chatId,
        messageId: currentPrivateMessage.messageId,
      }
    : {};
  const pending = [];

  if (!events.some((event) => event.eventKind === 'INITIAL_CONTEXT')) {
    pending.push({
      ...privateEventLink,
      turnId: input.turnId,
      eventKind: 'INITIAL_CONTEXT' as const,
      payload: asJsonValue(input.userContext),
    });
  } else if (
    stableJson(
      latestPayload(
        events,
        new Set(['INITIAL_CONTEXT', 'USER_CONTEXT', 'CORRECTION']),
      ),
    ) !== stableJson(input.userContext)
  ) {
    pending.push({
      ...privateEventLink,
      turnId: input.turnId,
      eventKind: hasFactCorrection(
        latestPayload(
          events,
          new Set(['INITIAL_CONTEXT', 'USER_CONTEXT', 'CORRECTION']),
        ),
        input.userContext,
      )
        ? ('CORRECTION' as const)
        : ('USER_CONTEXT' as const),
      payload: asJsonValue(input.userContext),
    });
  }

  if (
    !isEmptyContext(input.retrievalContext) &&
    stableJson(latestPayload(events, new Set(['RETRIEVAL']))) !==
      stableJson(input.retrievalContext)
  ) {
    pending.push({
      ...privateEventLink,
      turnId: input.turnId,
      eventKind: 'RETRIEVAL' as const,
      payload: asJsonValue(input.retrievalContext),
    });
  }

  pending.push({
    ...privateEventLink,
    turnId: input.turnId,
    eventKind: 'TURN_CONTEXT' as const,
    payload: asJsonValue({ time: input.time }),
  });

  if (events.length === 0 && input.legacyHistory?.length) {
    pending.push({
      ...privateEventLink,
      turnId: input.turnId,
      eventKind: 'LEGACY_HISTORY' as const,
      payload: asJsonValue({ messages: input.legacyHistory }),
    });
  }

  pending.push({
    turnId: input.turnId,
    eventKind: 'USER_MESSAGE' as const,
    messageChatId: input.messageId ? input.chatId : undefined,
    messageId: input.messageId,
    payload: asJsonValue({ content: input.currentUserMessage.content }),
  });
  await appendAiThreadEventsRepo(input.threadId, pending);

  stored = await getAiThreadContextRepo(input.threadId, currentPrivateMessage);
  events = (stored?.events ?? []) as ContextEvent[];
  const compacted = input.privateMode
    ? { events, cacheBoundary: stored?.cacheBoundary ?? 0 }
    : await maybeCompact(input.threadId, stored?.cacheBoundary ?? 0, events);
  events = compacted.events;
  const messages = serializeAiThreadEvents(events);
  const instructions = buildChatGenerationInstructions(storedRules);
  const stablePrefixCharacters = instructions.length;
  const dynamicCharacters = stableJson(messages).length;

  return {
    instructions,
    messages,
    telemetry: {
      promptVersion: prompt.version,
      promptHash: prompt.hash,
      threadId: input.threadId,
      cacheBoundary: compacted.cacheBoundary,
      stablePrefixCharacters,
      dynamicCharacters,
      providerCacheRead: 'unavailable',
      providerCacheWrite: 'unavailable',
    },
  };
}

export async function appendAiThreadAssistantEvent(
  threadId: string,
  turnId: string,
  content: string,
  message?: { chatId: bigint; messageId: bigint },
): Promise<void> {
  await appendAiThreadEventsRepo(threadId, [
    {
      turnId,
      eventKind: 'ASSISTANT',
      messageChatId: message?.chatId,
      messageId: message?.messageId,
      payload: asJsonValue({ content }),
    },
  ]);
}

export { buildChatGenerationInstructions } from './local-prompts';
