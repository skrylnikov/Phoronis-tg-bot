import { prisma } from '../db';

export async function findFactImpactsRepo(where: {
  usedInMessageId: bigint;
}) {
  return prisma.factImpact.findMany({ where });
}

export async function createManyFactImpactsRepo(
  data: Array<{
    factId: bigint;
    usedInMessageId: bigint;
    timestamp: Date;
  }>,
) {
  return prisma.factImpact.createMany({ data });
}

export async function updateManyFactImpactsRepo(
  where: { id: { in: bigint[] } },
  data: {
    userReaction?: 'positive' | 'negative' | 'neutral' | 'correction';
    messageReaction?: 'question' | 'clarification' | 'continue' | 'ignore' | 'none';
  },
) {
  return prisma.factImpact.updateMany({
    where,
    data,
  });
}
