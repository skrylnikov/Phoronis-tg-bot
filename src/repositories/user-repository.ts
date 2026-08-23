import type { User } from '@grammyjs/types';
import { LRUCache } from 'lru-cache';

import { prisma } from '../db';
import type { Prisma } from '../generated/prisma/client';
import { logger } from '../logger';
import { handleError } from '../utils/error-handler';

const cache = new LRUCache<number, true>({
  max: 10000,
  ttl: 24 * 60 * 60 * 1000,
  updateAgeOnGet: false,
  updateAgeOnHas: false,
});

export const saveUser = async (user: User) => {
  try {
    if (cache.has(user.id)) {
      return;
    }

    await prisma.user.upsert({
      create: {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        userName: user.username,
      },
      update: {
        firstName: user.first_name,
        lastName: user.last_name,
        userName: user.username,
      },
      where: {
        id: user.id,
      },
    });

    cache.set(user.id, true);
  } catch (error) {
    handleError(error, `Error saving user ${user.id}`);
  }
};

export async function findUserIdByUsername(
  userName: string,
): Promise<number | null> {
  try {
    const user = await prisma.user.findFirst({
      where: { userName },
      select: { id: true },
    });

    return user ? Number(user.id) : null;
  } catch (err) {
    logger.error(
      { event: 'user.lookup_by_username_failed', err, username: userName },
      'Error finding user by username',
    );
    return null;
  }
}

export async function findManyUsersRepo(
  where: Prisma.UserWhereInput,
  options?: {
    select?: Prisma.UserSelect;
    include?: Prisma.UserInclude;
  },
) {
  return prisma.user.findMany({
    where,
    ...options,
  });
}

export async function findUserByIdRepo<T extends Prisma.UserSelect>(
  userId: bigint,
  select?: T,
) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: select as any,
  });
}

export async function findFirstUserRepo(
  where: Prisma.UserWhereInput,
  options?: {
    select?: Prisma.UserSelect;
    include?: Prisma.UserInclude;
  },
) {
  return prisma.user.findFirst({
    where,
    ...options,
  });
}
