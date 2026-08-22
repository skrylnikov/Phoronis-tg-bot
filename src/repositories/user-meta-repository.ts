import { prisma } from '../db';
import type { Prisma } from '../generated/prisma/client';

export async function findUserByIdRepo(userId: bigint) {
  return prisma.user.findUnique({
    where: { id: userId },
  });
}

export async function updateUserMetaInfoRepo(
  userId: bigint,
  metaInfo: Prisma.InputJsonValue,
) {
  return prisma.user.update({
    where: { id: userId },
    data: { metaInfo },
  });
}

export async function findUsersForMigrationRepo(params: {
  take: number;
  orderBy: { id: 'asc' | 'desc' };
  cursor?: { id: bigint };
  skip?: number;
}) {
  return prisma.user.findMany(params);
}

export async function createUserFactForMigrationRepo(data: {
  userId: bigint;
  content: string;
  type: FactType;
  weight: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return prisma.userFact.create({ data });
}
