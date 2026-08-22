import cron, { type ScheduledTask } from 'node-cron';
import { z } from 'zod';
import { SCHEDULER_LOCK_KEY, withAdvisoryLock } from '../../advisory-lock';
import { prisma } from '../../db';
import { logger } from '../../logger';

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

async function migrateUserMetaInfo(
  userId: bigint,
  metaInfo: UserMetaInfo,
): Promise<{ migratedCount: number; totalCount: number; hadErrors: boolean }> {
  const facts = convertMetaInfoToFacts(metaInfo);
  const totalCount = facts.length;

  const existingFacts = await prisma.userFact.findMany({
    where: { userId },
  });

  const existingContents = new Set(existingFacts.map((f) => f.content));

  let migratedCount = 0;
  let hadErrors = false;
  const MIGRATION_DATE = new Date('2026-01-01T00:00:00Z');

  for (const fact of facts) {
    if (existingContents.has(fact.content)) {
      continue;
    }

    try {
      await prisma.userFact.create({
        data: {
          userId,
          content: fact.content,
          type: fact.type,
          weight: fact.weight,
          createdAt: MIGRATION_DATE,
          updatedAt: MIGRATION_DATE,
        },
      });

      migratedCount++;
    } catch (error) {
      hadErrors = true;
      logger.error(
        {
          event: 'user_meta.migration_fact_failed',
          userId,
          factType: fact.type,
          err: error,
        },
        'Failed to migrate user fact',
      );
    }
  }

  if (migratedCount > 0) {
    logger.info(
      {
        event: 'user_meta.migration_user_completed',
        userId,
        migratedCount,
        totalCount,
      },
      'User meta info migration completed',
    );
  }

  return { migratedCount, totalCount, hadErrors };
}

const MIGRATION_BATCH_SIZE = 10;

let migrationTask: ScheduledTask | null = null;
let isMigrationRunning = false;
let lastProcessedUserId: bigint | null = null;

export async function migrateNextBatchOfUsers() {
  let totalMigrated = 0;

  while (true) {
    const allUsers = await prisma.user.findMany({
      take: MIGRATION_BATCH_SIZE * 3,
      orderBy: { id: 'asc' },
      ...(lastProcessedUserId != null && {
        cursor: { id: lastProcessedUserId },
        skip: 1,
      }),
    });

    if (allUsers.length === 0) {
      logger.info(
        { event: 'user_meta.migration_completed', totalMigrated },
        'User meta info migration caught up',
      );
      return totalMigrated;
    }

    const users = allUsers.filter(
      (u) => u.metaInfo && Object.keys(u.metaInfo).length > 0,
    );

    lastProcessedUserId = allUsers[allUsers.length - 1].id;

    if (users.length === 0) {
      continue;
    }

    for (const user of users) {
      const metaInfoParse = userMetaInfoSchema.safeParse(user.metaInfo);

      if (!metaInfoParse.success) {
        logger.error(
          {
            event: 'user_meta.migration_invalid_format',
            userId: user.id,
            issueCount: metaInfoParse.error.issues.length,
          },
          'Invalid user meta info format',
        );
        continue;
      }

      const result = await migrateUserMetaInfo(user.id, metaInfoParse.data);
      totalMigrated += result.migratedCount;

      if (!result.hadErrors && result.migratedCount === result.totalCount) {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            metaInfo: {},
          },
        });
      } else if (result.hadErrors) {
        logger.error(
          {
            event: 'user_meta.migration_user_incomplete',
            userId: user.id,
            expectedFacts: result.totalCount,
            migratedFacts: result.migratedCount,
          },
          'Meta info migration had errors for user; preserving metaInfo for retry',
        );
      }
    }

    return totalMigrated;
  }
}

export function startMetaInfoMigration() {
  logger.info(
    { event: 'user_meta.migration_started' },
    'User meta info migration scheduler started',
  );

  migrationTask = cron.schedule(
    '*/10 * * * * *',
    () =>
      withAdvisoryLock(SCHEDULER_LOCK_KEY, async () => {
        if (isMigrationRunning) {
          return;
        }

        isMigrationRunning = true;

        try {
          const migrated = await migrateNextBatchOfUsers();
          if (migrated > 0) {
            logger.info(
              {
                event: 'user_meta.migration_batch_completed',
                migratedCount: migrated,
              },
              'User meta info migration batch completed',
            );
          } else {
            logger.info(
              { event: 'user_meta.migration_idle' },
              'No user meta info migration work remains',
            );
            stopMetaInfoMigration();
          }
        } catch (error) {
          logger.error(
            { event: 'user_meta.migration_failed', err: error },
            'Error in meta info migration',
          );
        } finally {
          isMigrationRunning = false;
        }
      }).catch((error) => {
        logger.error(
          { event: 'user_meta.migration_lock_failed', err: error },
          'Failed to acquire meta info migration lock',
        );
      }),
    {
      timezone: 'UTC',
    },
  );
}

export function stopMetaInfoMigration() {
  if (migrationTask) {
    migrationTask.stop();
    migrationTask = null;
    logger.info(
      { event: 'user_meta.migration_stopped' },
      'User meta info migration scheduler stopped',
    );
  }
}
