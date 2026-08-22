import { prisma } from '../db';

const staleProcessingMs = 5 * 60 * 1000;

export type GuestInteractionClaim =
  | { kind: 'claimed'; id: string }
  | { kind: 'answered'; answer: string | null }
  | { kind: 'processing' };

export async function claimGuestInteraction(input: {
  guestQueryId: string;
  chatId: bigint;
  userId: bigint;
  messageId?: bigint;
  query: string;
  referenceText?: string;
}): Promise<GuestInteractionClaim> {
  const existing = await prisma.guestInteraction.findUnique({
    where: { guestQueryId: input.guestQueryId },
    select: {
      id: true,
      answer: true,
      status: true,
      updatedAt: true,
    },
  });

  if (existing?.status === 'ANSWERED') {
    return { kind: 'answered', answer: existing.answer };
  }

  if (
    existing?.status === 'PROCESSING' &&
    Date.now() - existing.updatedAt.getTime() < staleProcessingMs
  ) {
    return { kind: 'processing' };
  }

  if (existing) {
    await prisma.guestInteraction.update({
      where: { id: existing.id },
      data: {
        chatId: input.chatId,
        userId: input.userId,
        messageId: input.messageId,
        query: input.query,
        referenceText: input.referenceText,
        answer: null,
        error: null,
        status: 'PROCESSING',
      },
    });
    return { kind: 'claimed', id: existing.id };
  }

  try {
    const interaction = await prisma.guestInteraction.create({
      data: {
        guestQueryId: input.guestQueryId,
        chatId: input.chatId,
        userId: input.userId,
        messageId: input.messageId,
        query: input.query,
        referenceText: input.referenceText,
      },
      select: { id: true },
    });
    return { kind: 'claimed', id: interaction.id };
  } catch (error) {
    const concurrent = await prisma.guestInteraction.findUnique({
      where: { guestQueryId: input.guestQueryId },
      select: { status: true, answer: true },
    });
    if (concurrent?.status === 'ANSWERED') {
      return { kind: 'answered', answer: concurrent.answer };
    }
    if (concurrent?.status === 'PROCESSING') {
      return { kind: 'processing' };
    }
    throw error;
  }
}

export async function markGuestInteractionAnswered(
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

export async function markGuestInteractionFailed(
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

export async function getRecentGuestInteractions(chatId: bigint, limit = 10) {
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
