import { describe, expect, test } from 'bun:test';
import { SCHEDULER_LOCK_KEYS, withAdvisoryLock } from '../advisory-lock';
import { prisma } from '../db';
import { migrateNextBatchOfUsers } from '../domain/user/migrate-meta-info';
import {
  commitAiThreadCacheBoundaryRepo,
  getAiThreadContextRepo,
} from '../repositories/ai-thread-context-repository';
import { findChatByIdRepo } from '../repositories/chat-repository';
import { recalculateFactImpactScoresRepo } from '../repositories/fact-impact-repository';
import { applyUserFactEvidenceRepo } from '../repositories/user-fact-repository';

let sequence = 0n;

function uniqueId(): bigint {
  sequence += 1n;
  return BigInt(Date.now()) * 1000n + sequence;
}

async function createChatFixture() {
  const userId = uniqueId();
  const chatId = -uniqueId();
  await prisma.user.create({ data: { id: userId, firstName: 'Integration' } });
  await prisma.chat.create({
    data: { id: chatId, title: 'Integration chat', chatType: 'GROUP' },
  });
  return { userId, chatId };
}

describe('privacy and runtime migration contracts', () => {
  test('reads only existing fields for new-member greetings', async () => {
    const { chatId } = await createChatFixture();
    await prisma.chat.update({
      where: { id: chatId },
      data: { greeting: 'Добро пожаловать!' },
    });

    await expect(
      findChatByIdRepo(chatId, { id: true, greeting: true }),
    ).resolves.toEqual({ id: chatId, greeting: 'Добро пожаловать!' });
  });

  test('backfills fact evidence idempotently', async () => {
    const { userId, chatId } = await createChatFixture();
    const messageId = uniqueId();
    await prisma.message.create({
      data: {
        id: messageId,
        chatId,
        senderId: userId,
        messageType: 'TEXT',
        text: 'Я люблю Rust',
        sentAt: new Date(),
      },
    });
    const fact = await prisma.userFact.create({
      data: {
        userId,
        content: 'Пользователь любит Rust',
        type: 'INTEREST',
        sourceChatId: chatId,
        sourceMessageId: messageId,
      },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await prisma.$executeRaw`
        INSERT INTO "UserFactEvidence" ("factId", "sourceChatId", "sourceMessageId")
        SELECT "id", "sourceChatId", "sourceMessageId"
        FROM "UserFact"
        WHERE "id" = ${fact.id}
          AND "sourceChatId" IS NOT NULL
          AND "sourceMessageId" IS NOT NULL
        ON CONFLICT ("factId", "sourceChatId", "sourceMessageId") DO NOTHING
      `;
    }

    expect(
      await prisma.userFactEvidence.count({ where: { factId: fact.id } }),
    ).toBe(1);
  });

  test('updates a fact only with a new source and rolls back partial failures', async () => {
    const { userId, chatId } = await createChatFixture();
    const firstMessageId = uniqueId();
    const secondMessageId = uniqueId();
    await prisma.message.createMany({
      data: [firstMessageId, secondMessageId].map((id) => ({
        id,
        chatId,
        senderId: userId,
        messageType: 'TEXT' as const,
        sentAt: new Date(),
      })),
    });
    const fact = await prisma.userFact.create({
      data: {
        userId,
        content: 'Факт',
        type: 'FACT',
        sourceChatId: chatId,
        sourceMessageId: firstMessageId,
        evidence: {
          create: { sourceChatId: chatId, sourceMessageId: firstMessageId },
        },
      },
    });

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION fail_fact_history_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced history failure';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_fact_history_insert
      BEFORE INSERT ON "FactHistory"
      FOR EACH ROW EXECUTE FUNCTION fail_fact_history_insert();
    `);
    try {
      await expect(
        applyUserFactEvidenceRepo({
          factId: fact.id,
          content: fact.content,
          sourceChatId: chatId,
          sourceMessageId: secondMessageId,
          reason: 'duplicate',
        }),
      ).rejects.toThrow('forced history failure');
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER fail_fact_history_insert ON "FactHistory"',
      );
      await prisma.$executeRawUnsafe(
        'DROP FUNCTION fail_fact_history_insert()',
      );
    }

    expect(
      await prisma.userFactEvidence.count({
        where: { factId: fact.id, sourceMessageId: secondMessageId },
      }),
    ).toBe(0);
    expect(
      await prisma.userFact.findUnique({ where: { id: fact.id } }),
    ).toMatchObject({ weight: 1, sourceMessageId: firstMessageId });

    expect(
      await applyUserFactEvidenceRepo({
        factId: fact.id,
        content: fact.content,
        sourceChatId: chatId,
        sourceMessageId: secondMessageId,
        reason: 'duplicate',
      }),
    ).toBe(true);
    expect(
      await applyUserFactEvidenceRepo({
        factId: fact.id,
        content: fact.content,
        sourceChatId: chatId,
        sourceMessageId: firstMessageId,
        reason: 'duplicate',
      }),
    ).toBe(false);
    expect(
      await prisma.userFact.findUnique({ where: { id: fact.id } }),
    ).toMatchObject({ weight: 2, sourceMessageId: secondMessageId });
  });

  test('deleting an expired parent preserves its reply', async () => {
    const { userId, chatId } = await createChatFixture();
    const parentId = uniqueId();
    const replyId = uniqueId();
    await prisma.message.createMany({
      data: [
        {
          id: parentId,
          chatId,
          senderId: userId,
          messageType: 'TEXT',
          text: 'private parent',
          private: true,
          sentAt: new Date(0),
        },
        {
          id: replyId,
          chatId,
          senderId: userId,
          replyToMessageId: parentId,
          messageType: 'TEXT',
          text: 'newer reply',
          sentAt: new Date(),
        },
      ],
    });

    await prisma.message.delete({
      where: { chatId_id: { chatId, id: parentId } },
    });

    expect(
      await prisma.message.findUnique({
        where: { chatId_id: { chatId, id: replyId } },
      }),
    ).toMatchObject({ replyToMessageId: null });
  });

  test('purges only thread contexts linked to private messages', async () => {
    const { userId, chatId } = await createChatFixture();
    const privateMessageId = uniqueId();
    const publicMessageId = uniqueId();
    await prisma.message.createMany({
      data: [
        {
          id: privateMessageId,
          chatId,
          senderId: userId,
          messageType: 'TEXT',
          private: true,
          sentAt: new Date(),
        },
        {
          id: publicMessageId,
          chatId,
          senderId: userId,
          messageType: 'TEXT',
          private: false,
          sentAt: new Date(),
        },
      ],
    });
    const privateThreadId = `private-${uniqueId()}`;
    const publicThreadId = `public-${uniqueId()}`;
    for (const [threadId, messageId] of [
      [privateThreadId, privateMessageId],
      [publicThreadId, publicMessageId],
    ] as const) {
      await prisma.aiThreadContext.create({
        data: {
          id: threadId,
          chatId,
          promptVersion: 1,
          promptHash: 'integration',
          rules: {},
          events: {
            create: {
              sequence: 1,
              turnId: `turn-${threadId}`,
              eventKind: 'USER_MESSAGE',
              messageChatId: chatId,
              messageId,
            },
          },
        },
      });
    }

    await prisma.$executeRaw`
      DELETE FROM "AiThreadContext" AS thread
      WHERE EXISTS (
        SELECT 1
        FROM "AiThreadContextEvent" AS event
        JOIN "Message" AS message
          ON message."chatId" = event."messageChatId"
         AND message."id" = event."messageId"
        WHERE event."threadId" = thread."id"
          AND message."private" = true
      )
    `;

    expect(
      await prisma.aiThreadContext.findUnique({
        where: { id: privateThreadId },
      }),
    ).toBeNull();
    expect(
      await prisma.aiThreadContextEvent.count({
        where: { threadId: privateThreadId },
      }),
    ).toBe(0);
    expect(
      await prisma.aiThreadContext.findUnique({
        where: { id: publicThreadId },
      }),
    ).not.toBeNull();
  });

  test('uses current private events once and excludes them from later context', async () => {
    const { userId, chatId } = await createChatFixture();
    const publicMessageId = uniqueId();
    const privateMessageId = uniqueId();
    const privateResponseId = uniqueId();
    await prisma.message.createMany({
      data: [
        {
          id: publicMessageId,
          chatId,
          senderId: userId,
          messageType: 'TEXT',
          private: false,
          sentAt: new Date(),
        },
        {
          id: privateMessageId,
          chatId,
          senderId: userId,
          messageType: 'TEXT',
          private: true,
          sentAt: new Date(),
        },
        {
          id: privateResponseId,
          chatId,
          senderId: userId,
          messageType: 'TEXT',
          private: true,
          sentAt: new Date(),
        },
      ],
    });
    const threadId = `private-filter-${uniqueId()}`;
    await prisma.aiThreadContext.create({
      data: {
        id: threadId,
        chatId,
        promptVersion: 1,
        promptHash: 'integration',
        rules: {},
        events: {
          create: [
            {
              sequence: 1,
              turnId: 'public-turn',
              eventKind: 'USER_MESSAGE',
              messageChatId: chatId,
              messageId: publicMessageId,
            },
            {
              sequence: 2,
              turnId: 'private-turn',
              eventKind: 'TURN_CONTEXT',
              messageChatId: chatId,
              messageId: privateMessageId,
            },
            {
              sequence: 3,
              turnId: 'private-turn',
              eventKind: 'USER_MESSAGE',
              messageChatId: chatId,
              messageId: privateMessageId,
            },
            {
              sequence: 4,
              turnId: 'private-turn',
              eventKind: 'ASSISTANT',
              messageChatId: chatId,
              messageId: privateResponseId,
            },
          ],
        },
      },
    });

    expect(
      (
        await getAiThreadContextRepo(threadId, {
          chatId,
          messageId: privateMessageId,
        })
      )?.events.map((event) => event.sequence),
    ).toEqual([1, 2, 3]);
    expect(
      (await getAiThreadContextRepo(threadId))?.events.map(
        (event) => event.sequence,
      ),
    ).toEqual([1]);

    await prisma.message.deleteMany({
      where: { chatId, id: { in: [privateMessageId, privateResponseId] } },
    });
    expect(
      await prisma.aiThreadContextEvent.count({ where: { threadId } }),
    ).toBe(1);
  });

  test('reads and prunes AI context from the latest committed boundary', async () => {
    const { chatId } = await createChatFixture();
    const threadId = `bounded-${uniqueId()}`;
    await prisma.aiThreadContext.create({
      data: {
        id: threadId,
        chatId,
        promptVersion: 1,
        promptHash: 'integration',
        rules: {},
        cacheBoundary: 1,
        events: {
          create: [
            {
              sequence: 1,
              turnId: 'old',
              eventKind: 'USER_MESSAGE',
              payload: { content: 'old' },
            },
            {
              sequence: 2,
              turnId: 'cache-boundary:1',
              eventKind: 'CACHE_BOUNDARY',
              payload: { summary: 'summary' },
            },
            {
              sequence: 3,
              turnId: 'tail',
              eventKind: 'USER_MESSAGE',
              payload: { content: 'tail' },
            },
          ],
        },
      },
    });

    expect(
      (await getAiThreadContextRepo(threadId))?.events.map(
        (event) => event.sequence,
      ),
    ).toEqual([2, 3]);

    await commitAiThreadCacheBoundaryRepo(threadId, 2, 3, {
      summary: 'new summary',
    });
    expect(
      (await getAiThreadContextRepo(threadId))?.events.map(
        (event) => event.sequence,
      ),
    ).toEqual([4]);
  });

  test('does not prune a context tail appended during compaction', async () => {
    const { chatId } = await createChatFixture();
    const threadId = `concurrent-${uniqueId()}`;
    await prisma.aiThreadContext.create({
      data: {
        id: threadId,
        chatId,
        promptVersion: 1,
        promptHash: 'integration',
        rules: {},
        events: {
          create: {
            sequence: 1,
            turnId: 'snapshot',
            eventKind: 'USER_MESSAGE',
          },
        },
      },
    });
    await prisma.aiThreadContextEvent.create({
      data: {
        threadId,
        sequence: 2,
        turnId: 'concurrent-tail',
        eventKind: 'ASSISTANT',
      },
    });

    await expect(
      commitAiThreadCacheBoundaryRepo(threadId, 1, 1, { summary: 'stale' }),
    ).rejects.toThrow('AI thread changed during compaction');

    expect(
      await prisma.aiThreadContextEvent.count({ where: { threadId } }),
    ).toBe(2);
  });

  test('recalculates fact impact scores without loading impact relations', async () => {
    const { userId } = await createChatFixture();
    const fact = await prisma.userFact.create({
      data: {
        userId,
        content: 'Set-based score',
        type: 'FACT',
        usageCount: 2,
      },
    });
    await prisma.factImpact.createMany({
      data: [
        {
          factId: fact.id,
          usedInMessageId: uniqueId(),
          timestamp: new Date(),
          userReaction: 'positive',
          messageReaction: 'question',
        },
        {
          factId: fact.id,
          usedInMessageId: uniqueId(),
          timestamp: new Date(),
          userReaction: 'negative',
          messageReaction: 'ignore',
        },
      ],
    });

    await expect(recalculateFactImpactScoresRepo()).resolves.toBeGreaterThan(0);
    const updated = await prisma.userFact.findUnique({
      where: { id: fact.id },
    });
    expect(updated?.impactScore).toBeGreaterThan(0.6);
    expect(updated?.impactScore).toBeLessThan(0.8);
  });

  test('uses independent scheduler locks for different task types', async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withAdvisoryLock(SCHEDULER_LOCK_KEYS.factImpact, async () => {
      started?.();
      await gate;
      return 'first';
    });
    await startedPromise;

    await expect(
      withAdvisoryLock(SCHEDULER_LOCK_KEYS.factImpact, async () => 'same'),
    ).resolves.toBeUndefined();
    await expect(
      withAdvisoryLock(
        SCHEDULER_LOCK_KEYS.privateMessageCleanup,
        async () => 'different',
      ),
    ).resolves.toBe('different');
    release?.();
    await expect(first).resolves.toBe('first');
  });

  test('converges legacy metaInfo when facts already exist', async () => {
    const { userId } = await createChatFixture();
    await prisma.user.update({
      where: { id: userId },
      data: { metaInfo: { interests: [{ value: 'Rust', weight: 3 }] } },
    });
    await prisma.userFact.create({
      data: { userId, content: 'Rust', type: 'INTEREST', weight: 3 },
    });

    await migrateNextBatchOfUsers();
    await migrateNextBatchOfUsers();

    expect(
      await prisma.userFact.count({ where: { userId, content: 'Rust' } }),
    ).toBe(1);
    expect(
      await prisma.user.findUnique({ where: { id: userId } }),
    ).toMatchObject({ metaInfo: {} });
  });
});
