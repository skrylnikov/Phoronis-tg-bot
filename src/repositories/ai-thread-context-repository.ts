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

export async function getAiThreadContextRepo(threadId: string) {
  return prisma.aiThreadContext.findUnique({
    where: { id: threadId },
    include: { events: { orderBy: { sequence: 'asc' } } },
  });
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

export async function updateAiThreadCacheBoundaryRepo(
  threadId: string,
  cacheBoundary: number,
) {
  return prisma.aiThreadContext.update({
    where: { id: threadId },
    data: { cacheBoundary },
  });
}
