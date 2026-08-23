import { prisma } from '../db';

const staleProcessingMs = 5 * 60 * 1000;

export async function findGuestInteraction(guestQueryId: string) {
  return prisma.guestInteraction.findUnique({
    where: { guestQueryId },
    select: {
      id: true,
      answer: true,
      status: true,
      updatedAt: true,
    },
  });
}

export async function updateGuestInteraction(
  id: string,
  data: {
    chatId: bigint;
    userId: bigint;
    messageId?: bigint;
    query: string;
    referenceText?: string;
    answer: null;
    error: null;
    status: 'PROCESSING';
  },
) {
  return prisma.guestInteraction.update({
    where: { id },
    data,
  });
}

export async function createGuestInteraction(input: {
  guestQueryId: string;
  chatId: bigint;
  userId: bigint;
  messageId?: bigint;
  query: string;
  referenceText?: string;
}) {
  return prisma.guestInteraction.create({
    data: input,
    select: { id: true },
  });
}

export async function markGuestInteractionAnsweredRepo(
  id: string,
  answer: string,
): Promise<void> {
  await prisma.guestInteraction.update({
    where: { id },
    data: {
      answer,
      error: null,
      status: 'ANSWERED',
      answeredAt: new Date(),
    },
  });
}

export async function markGuestInteractionFailedRepo(
  id: string,
  error: unknown,
): Promise<void> {
  await prisma.guestInteraction.update({
    where: { id },
    data: {
      status: 'FAILED',
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

export async function getRecentGuestInteractionsRepo(
  chatId: bigint,
  limit = 10,
) {
  return prisma.guestInteraction.findMany({
    where: { chatId, status: 'ANSWERED' },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      query: true,
      referenceText: true,
      answer: true,
      createdAt: true,
    },
  });
}

export { staleProcessingMs };
