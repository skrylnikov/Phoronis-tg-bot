import { prisma } from '../db';
import type {
  AiThreadContextEventKind,
  Prisma,
} from '../generated/prisma/client';

export interface CreateAiThreadContextInput {
  id: string;
  chatId: bigint;
  rootMessageId?: bigint | null;
  promptVersion: number;
  promptHash: string;
  rules: Prisma.InputJsonValue;
}

export interface AppendAiThreadEventInput {
  turnId: string;
  eventKind: AiThreadContextEventKind;
  messageChatId?: bigint;
  messageId?: bigint;
  payload?: Prisma.InputJsonValue;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

export async function getAiThreadContextRepo(
  threadId: string,
  includePrivateMessage?: { chatId: bigint; messageId: bigint },
) {
  const [thread, boundary] = await Promise.all([
    prisma.aiThreadContext.findUnique({ where: { id: threadId } }),
    prisma.aiThreadContextEvent.findFirst({
      where: { threadId, eventKind: 'CACHE_BOUNDARY' },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    }),
  ]);
  if (!thread) return null;

  const events = await prisma.aiThreadContextEvent.findMany({
    where: {
      threadId,
      ...(boundary ? { sequence: { gte: boundary.sequence } } : {}),
      OR: [
        { messageId: null },
        { message: { is: { private: false } } },
        ...(includePrivateMessage
          ? [
              {
                messageChatId: includePrivateMessage.chatId,
                messageId: includePrivateMessage.messageId,
              },
            ]
          : []),
      ],
    },
    orderBy: { sequence: 'asc' },
  });
  return { ...thread, events };
}

export async function ensureAiThreadContextRepo(
  input: CreateAiThreadContextInput,
) {
  const existing = await prisma.aiThreadContext.findUnique({
    where: { id: input.id },
  });
  if (existing) return existing;

  try {
    return await prisma.aiThreadContext.create({ data: input });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const createdByConcurrentRequest =
        await prisma.aiThreadContext.findUnique({ where: { id: input.id } });
      if (createdByConcurrentRequest) return createdByConcurrentRequest;
    }
    throw error;
  }
}

export async function appendAiThreadEventsRepo(
  threadId: string,
  events: AppendAiThreadEventInput[],
) {
  if (events.length === 0) return [];

  return prisma.$transaction(async (tx) => {
    await tx.aiThreadContext.update({
      where: { id: threadId },
      data: { updatedAt: new Date() },
    });

    const existing = await tx.aiThreadContextEvent.findMany({
      where: {
        threadId,
        OR: events.map(({ turnId, eventKind }) => ({ turnId, eventKind })),
      },
      select: { turnId: true, eventKind: true },
    });
    const existingKeys = new Set(
      existing.map((event) => `${event.turnId}:${event.eventKind}`),
    );
    const latest = await tx.aiThreadContextEvent.findFirst({
      where: { threadId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    let sequence = latest?.sequence ?? 0;
    const created = [];

    for (const event of events) {
      const key = `${event.turnId}:${event.eventKind}`;
      if (existingKeys.has(key)) continue;

      const item = await tx.aiThreadContextEvent.create({
        data: {
          threadId,
          sequence: ++sequence,
          turnId: event.turnId,
          eventKind: event.eventKind,
          messageChatId: event.messageChatId,
          messageId: event.messageId,
          payload: event.payload,
        },
      });
      created.push(item);
      existingKeys.add(key);
    }

    return created;
  });
}

export async function commitAiThreadCacheBoundaryRepo(
  threadId: string,
  cacheBoundary: number,
  summarizedThroughSequence: number,
  payload: Prisma.InputJsonValue,
) {
  return prisma.$transaction(async (tx) => {
    await tx.aiThreadContext.update({
      where: { id: threadId },
      data: { cacheBoundary, updatedAt: new Date() },
    });
    const latest = await tx.aiThreadContextEvent.findFirst({
      where: { threadId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    if ((latest?.sequence ?? 0) !== summarizedThroughSequence) {
      throw new Error('AI thread changed during compaction');
    }

    const boundary = await tx.aiThreadContextEvent.create({
      data: {
        threadId,
        sequence: summarizedThroughSequence + 1,
        turnId: `cache-boundary:${cacheBoundary}`,
        eventKind: 'CACHE_BOUNDARY',
        payload,
      },
    });
    await tx.aiThreadContextEvent.deleteMany({
      where: { threadId, sequence: { lt: boundary.sequence } },
    });
    return boundary;
  });
}
