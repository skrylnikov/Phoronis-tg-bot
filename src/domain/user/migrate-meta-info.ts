import cron, { type ScheduledTask } from 'node-cron';
import { z } from 'zod';
import { SCHEDULER_LOCK_KEYS, withAdvisoryLock } from '../../advisory-lock';
import { logger } from '../../logger';
import { findUserFactsRepo } from '../../repositories/user-fact-repository';
import {
  createUserFactForMigrationRepo,
  findUsersForMigrationRepo,
  updateUserMetaInfoRepo,
} from '../../repositories/user-meta-repository';

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

export function convertMetaInfoToFacts(metaInfo: UserMetaInfo): FactItem[] {
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
): Promise<{
  migratedCount: number;
  totalCount: number;
  hadErrors: boolean;
  convergedCount: number;
}> {
  const facts = convertMetaInfoToFacts(metaInfo);
  const totalCount = facts.length;

  const existingFacts = await findUserFactsRepo(userId);

  const existingContents = new Set(existingFacts.map((f) => f.content));

  let migratedCount = 0;
  let convergedCount = 0;
  let hadErrors = false;
  const MIGRATION_DATE = new Date('2026-01-01T00:00:00Z');

  for (const fact of facts) {
    if (existingContents.has(fact.content)) {
      convergedCount++;
      continue;
    }

    try {
      await createUserFactForMigrationRepo({
        userId,
        content: fact.content,
        type: fact.type,
        weight: fact.weight,
        createdAt: MIGRATION_DATE,
        updatedAt: MIGRATION_DATE,
      });

      migratedCount++;
      convergedCount++;
      existingContents.add(fact.content);
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

  return { migratedCount, totalCount, hadErrors, convergedCount };
}

const MIGRATION_BATCH_SIZE = 10;

let migrationTask: ScheduledTask | null = null;
let migrationRun: Promise<unknown> | null = null;
let isMigrationRunning = false;

export async function migrateNextBatchOfUsers() {
  let totalMigrated = 0;
  let processedPayloads = 0;
  let lastProcessedUserId: bigint | null = null;

  while (true) {
    const allUsers = await findUsersForMigrationRepo({
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
      return processedPayloads;
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

      if (!result.hadErrors && result.convergedCount === result.totalCount) {
        await updateUserMetaInfoRepo(user.id, {});
        processedPayloads++;
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

    return processedPayloads;
  }
}

export function startMetaInfoMigration() {
  if (migrationTask) return;
  logger.info(
    { event: 'user_meta.migration_started' },
    'User meta info migration scheduler started',
  );

  migrationTask = cron.schedule(
    '*/10 * * * * *',
    () => {
      const run = withAdvisoryLock(
        SCHEDULER_LOCK_KEYS.metaInfoMigration,
        async () => {
          if (isMigrationRunning) {
            return;
          }

          isMigrationRunning = true;

          try {
            const processedCount = await migrateNextBatchOfUsers();
            if (processedCount > 0) {
              logger.info(
                {
                  event: 'user_meta.migration_batch_completed',
                  processedCount,
                },
                'User meta info migration batch completed',
              );
            } else {
              logger.info(
                { event: 'user_meta.migration_idle' },
                'No user meta info migration work remains',
              );
              stopMetaInfoSchedule();
            }
          } catch (error) {
            logger.error(
              { event: 'user_meta.migration_failed', err: error },
              'Error in meta info migration',
            );
          } finally {
            isMigrationRunning = false;
          }
        },
      ).catch((error) => {
        logger.error(
          { event: 'user_meta.migration_lock_failed', err: error },
          'Failed to acquire meta info migration lock',
        );
      });
      migrationRun = run.finally(() => {
        migrationRun = null;
      });
      return migrationRun;
    },
    {
      timezone: 'UTC',
    },
  );
}

function stopMetaInfoSchedule(): void {
  if (migrationTask) {
    migrationTask.stop();
    migrationTask = null;
    logger.info(
      { event: 'user_meta.migration_stopped' },
      'User meta info migration scheduler stopped',
    );
  }
}

export async function stopMetaInfoMigration(): Promise<void> {
  stopMetaInfoSchedule();
  await migrationRun;
}
