import type { Message } from '@prisma/client';
import { embed } from 'ai';
import cron, { type ScheduledTask } from 'node-cron';
import { z } from 'zod';
import { openRouter } from '../../ai/ai';
import { prisma } from '../../db';
import { logger } from '../../logger';
import { qdrantClient } from '../../qdrant';

const userMetaInfoSchema = z.object({
  interests: z
    .array(
      z.object({
        value: z.string(),
        weight: z.number().default(1),
      }),
    )
    .optional(),
  communication_style: z
    .array(
      z.object({
        value: z.string(),
        weight: z.number().default(1),
      }),
    )
    .optional(),
  notable_traits: z
    .array(
      z.object({
        value: z.string(),
        weight: z.number().default(1),
      }),
    )
    .optional(),
  topics: z
    .array(
      z.object({
        value: z.string(),
        weight: z.number().default(1),
      }),
    )
    .optional(),
  notes: z
    .array(
      z.object({
        value: z.string(),
        weight: z.number().default(1),
      }),
    )
    .optional(),
});

type UserMetaInfo = z.infer<typeof userMetaInfoSchema>;

interface FactItem {
  content: string;
  type: 'TEXT_STYLE' | 'FACT' | 'INTEREST';
  weight: number;
}

function convertMetaInfoToFacts(metaInfo: UserMetaInfo): FactItem[] {
  const facts: FactItem[] = [];

  if (metaInfo.interests) {
    for (const interest of metaInfo.interests) {
      facts.push({
        content: interest.value,
        type: 'INTEREST',
        weight: interest.weight,
      });
    }
  }

  if (metaInfo.communication_style) {
    for (const style of metaInfo.communication_style) {
      facts.push({
        content: style.value,
        type: 'TEXT_STYLE',
        weight: style.weight,
      });
    }
  }

  if (metaInfo.notable_traits) {
    for (const trait of metaInfo.notable_traits) {
      facts.push({
        content: trait.value,
        type: 'FACT',
        weight: trait.weight,
      });
    }
  }

  if (metaInfo.topics) {
    for (const topic of metaInfo.topics) {
      facts.push({
        content: topic.value,
        type: 'INTEREST',
        weight: topic.weight,
      });
    }
  }

  if (metaInfo.notes) {
    for (const note of metaInfo.notes) {
      facts.push({
        content: note.value,
        type: 'FACT',
        weight: note.weight,
      });
    }
  }

  return facts;
}

async function checkFactExistsInQdrant(
  userId: bigint,
  content: string,
): Promise<boolean> {
  try {
    const result = await embed({
      model: openRouter.textEmbeddingModel('qwen/qwen3-embedding-8b'),
      value: content,
      providerOptions: {
        llamaGate: {
          dimensions: 4096,
        },
      },
    });

    const searchResults = await qdrantClient.search('user-facts', {
      vector: result.embedding,
      filter: {
        must: [
          {
            key: 'userId',
            match: {
              value: Number(userId),
            },
          },
          {
            key: 'content',
            match: {
              value: content,
            },
          },
        ],
      },
      limit: 1,
    });

    return searchResults.length > 0;
  } catch (error) {
    logger.error(error, 'Error checking fact existence in Qdrant');
    return false;
  }
}

async function migrateUserMetaInfo(userId: bigint, metaInfo: UserMetaInfo) {
  const facts = convertMetaInfoToFacts(metaInfo);

  const existingFacts = await prisma.userFact.findMany({
    where: { userId },
  });

  const existingContents = new Set(existingFacts.map((f) => f.content));

  let migratedCount = 0;
  const MIGRATION_DATE = new Date('2026-01-01T00:00:00Z');

  for (const fact of facts) {
    if (existingContents.has(fact.content)) {
      continue;
    }

    const existsInQdrant = await checkFactExistsInQdrant(userId, fact.content);
    if (existsInQdrant) {
      continue;
    }

    try {
      const createdFact = await prisma.userFact.create({
        data: {
          userId,
          content: fact.content,
          type: fact.type,
          weight: fact.weight,
          createdAt: MIGRATION_DATE,
          updatedAt: MIGRATION_DATE,
        },
      });

      const embeddingResult = await embed({
        model: openRouter.textEmbeddingModel('qwen/qwen3-embedding-8b'),
        value: fact.content,
        providerOptions: {
          llamaGate: {
            dimensions: 4096,
          },
        },
      });

      await qdrantClient.upsert('user-facts', {
        points: [
          {
            id: Number(createdFact.id),
            vector: embeddingResult.embedding,
            payload: {
              content: fact.content,
              userId: Number(userId),
              type: fact.type,
            },
          },
        ],
      });

      migratedCount++;
    } catch (error) {
      logger.error(
        error,
        `Error migrating fact for user ${userId}: ${fact.content}`,
      );
    }
  }

  if (migratedCount > 0) {
    logger.info(`Migrated ${migratedCount} facts for user ${userId}`);
  }

  return migratedCount;
}

const MIGRATION_BATCH_SIZE = 10;

let migrationTask: ScheduledTask | null = null;

export async function migrateNextBatchOfUsers() {
  const allUsers = await prisma.user.findMany({
    include: {
      UserFact: {
        select: { content: true },
      },
    },
    take: MIGRATION_BATCH_SIZE * 3,
    orderBy: { id: 'asc' },
  });

  const users = allUsers.filter(
    (u) => u.metaInfo && Object.keys(u.metaInfo).length > 0,
  );

  if (users.length === 0) {
    logger.info('No more users to migrate');
    return 0;
  }

  let totalMigrated = 0;

  for (const user of users) {
    const metaInfoParse = userMetaInfoSchema.safeParse(user.metaInfo);

    if (!metaInfoParse.success) {
      logger.error(
        user.metaInfo,
        `Invalid metaInfo format for user ${user.id}`,
      );
      continue;
    }

    const migratedCount = await migrateUserMetaInfo(
      user.id,
      metaInfoParse.data,
    );
    totalMigrated += migratedCount;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        metaInfo: {},
      },
    });
  }

  return totalMigrated;
}

export function startMetaInfoMigration() {
  logger.info('Starting meta info migration scheduler...');

  migrationTask = cron.schedule('*/10 * * * * *', async () => {
    try {
      const migrated = await migrateNextBatchOfUsers();
      if (migrated > 0) {
        logger.info(`Migration batch completed: ${migrated} facts migrated`);
      } else {
        logger.info('No users to migrate, stopping migration scheduler');
        stopMetaInfoMigration();
      }
    } catch (error) {
      logger.error(error, 'Error in meta info migration');
    }
  });
}

export function stopMetaInfoMigration() {
  if (migrationTask) {
    migrationTask.stop();
    migrationTask = null;
    logger.info('Meta info migration scheduler stopped');
  }
}
