import { prisma } from '../db';

export async function updateMemoryRepo(
  id: bigint,
  data: { content: string; updatedAt: Date },
) {
  return prisma.memory.update({
    where: { id },
    data,
  });
}

export async function createMemoryRepo(data: {
  userId: bigint;
  chatId: bigint;
  content: string;
  isUser: boolean;
}) {
  return prisma.memory.create({ data });
}

export async function findMemoriesForClearRepo(where: {
  userId?: bigint;
  chatId?: bigint;
  isUser?: boolean;
  OR?: Array<{
    userId?: bigint;
    chatId?: bigint;
    isUser?: boolean;
  }>;
}) {
  return prisma.memory.findMany({
    where,
    select: { id: true },
  });
}

export async function deleteMemoriesRepo(ids: bigint[]) {
  return prisma.memory.deleteMany({
    where: { id: { in: ids } },
  });
}

export async function findRecentMemoriesRepo(
  userId: bigint,
  chatId: bigint,
  limit: number,
) {
  return prisma.memory.findMany({
    where: {
      OR: [
        { userId, isUser: true },
        { chatId, isUser: false },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function findRecentMemoriesForUsersRepo(
  userIds: number[],
  chatId: bigint,
  limitPerUser: number,
) {
  const userMemories = await prisma.memory.findMany({
    where: {
      userId: { in: userIds.map(BigInt) },
      isUser: true,
    },
    orderBy: { createdAt: 'desc' },
    take: userIds.length * limitPerUser,
  });

  const chatMemories = await prisma.memory.findMany({
    where: {
      chatId,
      isUser: false,
    },
    orderBy: { createdAt: 'desc' },
    take: limitPerUser,
  });

  return { userMemories, chatMemories };
}

export async function getUserPersonalMemoriesRepo(
  userId: bigint,
  options: { chatId?: bigint; allChats?: boolean } = {},
) {
  return prisma.memory.findMany({
    where: {
      userId,
      isUser: true,
      ...(options.allChats ? {} : { chatId: options.chatId }),
    },
    select: {
      content: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}
