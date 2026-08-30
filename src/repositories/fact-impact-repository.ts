import { prisma } from '../db';

export async function findFactImpactsRepo(where: { usedInMessageId: bigint }) {
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
    messageReaction?:
      | 'question'
      | 'clarification'
      | 'continue'
      | 'ignore'
      | 'none';
  },
) {
  return prisma.factImpact.updateMany({
    where,
    data,
  });
}

export async function recalculateFactImpactScoresRepo(): Promise<number> {
  const updated = await prisma.$queryRaw<Array<{ id: bigint }>>`
    UPDATE "UserFact" AS fact
    SET "impactScore" = scores.value,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM (
      SELECT
        impact."factId",
        SUM(
          (
            CASE impact."userReaction"
              WHEN 'positive' THEN 2
              WHEN 'negative' THEN -2
              WHEN 'correction' THEN -1
              ELSE 0
            END
            + CASE impact."messageReaction"
              WHEN 'question' THEN 1.5
              WHEN 'clarification' THEN 1.5
              WHEN 'continue' THEN 1
              WHEN 'ignore' THEN -0.5
              ELSE 0
            END
          ) * EXP(-EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - impact."timestamp")) / 2592000)
        ) / SQRT(COUNT(*)) AS value
      FROM "FactImpact" AS impact
      GROUP BY impact."factId"
    ) AS scores
    WHERE fact.id = scores."factId"
      AND fact."usageCount" > 0
    RETURNING fact.id
  `;
  return updated.length;
}
