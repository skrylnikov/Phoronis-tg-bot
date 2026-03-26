import type { User } from '@grammyjs/types';
import { LRUCache } from 'lru-cache';

import { prisma } from '../db';
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
