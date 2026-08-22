import {
  createGuestInteraction,
  findGuestInteraction,
  markGuestInteractionAnsweredRepo,
  markGuestInteractionFailedRepo,
  getRecentGuestInteractionsRepo,
  updateGuestInteraction,
  staleProcessingMs,
} from '../repositories/guest-interaction-repository';

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
  const existing = await findGuestInteraction(input.guestQueryId);

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
    await updateGuestInteraction(existing.id, {
      chatId: input.chatId,
      userId: input.userId,
      messageId: input.messageId,
      query: input.query,
      referenceText: input.referenceText,
      answer: null,
      error: null,
      status: 'PROCESSING',
    });
    return { kind: 'claimed', id: existing.id };
  }

  try {
    const interaction = await createGuestInteraction({
      guestQueryId: input.guestQueryId,
      chatId: input.chatId,
      userId: input.userId,
      messageId: input.messageId,
      query: input.query,
      referenceText: input.referenceText,
    });
    return { kind: 'claimed', id: interaction.id };
  } catch (error) {
    const concurrent = await findGuestInteraction(input.guestQueryId);
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
  await markGuestInteractionAnsweredRepo(id, answer);
}

export async function markGuestInteractionFailed(
  id: string,
  error: unknown,
): Promise<void> {
  await markGuestInteractionFailedRepo(id, error);
}

export async function getRecentGuestInteractions(chatId: bigint, limit = 10) {
  return getRecentGuestInteractionsRepo(chatId, limit);
}
