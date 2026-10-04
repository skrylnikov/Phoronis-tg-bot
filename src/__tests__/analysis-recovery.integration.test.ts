import { describe, expect, test } from 'bun:test';
import { prisma } from '../db';
import {
  attachAnalysisParents,
  chooseAnalysisReplies,
} from '../domain/user/analysis-window';
import {
  claimNextBackgroundJobRepo,
  deferAnalysisJobRepo,
  findFailedAnalysisJobsRepo,
  freezeAnalysisWindowRepo,
  replayFailedAnalysisJobRepo,
} from '../repositories/background-job-repository';
import {
  findAnalysisSourcesRepo,
  findMessagesRepo,
} from '../repositories/message-repository';
import {
  applyUserFactEvidenceRepo,
  createUserFactRepo,
} from '../repositories/user-fact-repository';

const url = new URL(
  process.env.DATABASE_URL || 'postgresql://localhost/unconfigured',
);
const isolated =
  process.env.RUN_ANALYSIS_DB_TESTS === '1' &&
  url.hostname === '127.0.0.1' &&
  url.pathname === '/phoronis_alias_test';
describe.skipIf(!isolated)('analysis recovery on isolated PostgreSQL', () => {
  test('fixed window, one-hop replies, guarded replay and quota deferral', async () => {
    const userId = BigInt(Date.now()),
      authorId = userId + 1n,
      botId = userId + 2n,
      chatId = -userId,
      otherChat = chatId - 1n;
    const cutoffAt = new Date('2026-10-01T00:00:00Z');
    await prisma.user.createMany({
      data: [{ id: userId }, { id: authorId }, { id: botId }],
    });
    await prisma.chat.createMany({
      data: [
        { id: chatId, chatType: 'GROUP', title: 'Analysis isolated test' },
        { id: otherChat, chatType: 'GROUP', title: 'Analysis isolated test' },
      ],
    });
    const source = (
      id: bigint,
      senderId = userId,
      privateMode = false,
      sentAt = cutoffAt,
    ) => ({
      id,
      chatId,
      senderId,
      private: privateMode,
      sentAt,
      text: 'Привет',
      messageType: 'TEXT' as const,
    });
    const ids: string[] = [];
    try {
      await prisma.message.createMany({
        data: Array.from({ length: 31 }, (_, i) => source(BigInt(i + 1))),
      });
      const base = await findMessagesRepo({
        chatId,
        senderId: userId,
        private: false,
        sentAt: { lte: cutoffAt },
      });
      expect(base.map((m) => m.id)).toEqual(
        Array.from({ length: 30 }, (_, i) => BigInt(31 - i)),
      );
      await prisma.message.createMany({
        data: [
          {
            ...source(32n, authorId),
            replyToMessageId: 2n,
            text: 'Дима, привет',
          },
          { ...source(33n, botId), replyToMessageId: 2n },
          { ...source(34n, authorId, true), replyToMessageId: 2n },
          {
            ...source(35n, authorId, false, new Date(cutoffAt.getTime() + 1)),
            replyToMessageId: 2n,
          },
          { ...source(36n, authorId), replyToMessageId: 32n },
          { ...source(2n, authorId), chatId: otherChat },
        ],
      });
      await prisma.message.update({
        where: { chatId_id: { chatId, id: 3n } },
        data: { replyToMessageId: 1n },
      });
      const refreshedBase = await findAnalysisSourcesRepo({
        chatId,
        botId,
        cutoffAt,
        senderId: userId,
        ids: base.map((m) => m.id),
      });
      const candidates = await findAnalysisSourcesRepo({
        chatId,
        botId,
        cutoffAt,
        replyToIds: refreshedBase.map((m) => m.id),
        parentIds: [1n],
      });
      expect(candidates.map((m) => m.id)).toEqual([1n, 32n]);
      const window = {
        windowVersion: 1,
        cutoffAt: cutoffAt.toISOString(),
        baseMessageIds: base.map((m) => String(m.id)),
        ...chooseAnalysisReplies(refreshedBase, candidates),
      };
      expect(
        attachAnalysisParents(refreshedBase, candidates).find(
          (m) => m.id === 32n,
        )?.replyToMessage?.senderId,
      ).toBe(userId);
      const payload = {
        userId: String(userId),
        chatId: String(chatId),
        isGroup: true,
        ...window,
      };
      const failed = await prisma.backgroundJob.create({
        data: {
          type: 'USER_MESSAGE_ANALYSIS',
          status: 'FAILED',
          dedupeKey: `analysis-test:${chatId}`,
          payload,
          createdAt: cutoffAt,
          attempts: 5,
          lastError: 'The operation timed out.',
        },
      });
      ids.push(failed.id);
      for (const [status, type] of [
        ['COMPLETED', 'USER_MESSAGE_ANALYSIS'],
        ['PROCESSING', 'USER_MESSAGE_ANALYSIS'],
        ['FAILED', 'PAYMENT_BUYER_NOTIFICATION'],
      ] as const) {
        const row = await prisma.backgroundJob.create({
          data: {
            type,
            status,
            dedupeKey: `analysis-test:${chatId}:${status}:${type}`,
            payload,
            createdAt: cutoffAt,
          },
        });
        ids.push(row.id);
      }
      const selected = await findFailedAnalysisJobsRepo({
        chatId,
        userId,
        from: cutoffAt,
        to: cutoffAt,
        limit: 10,
      });
      expect(selected.map((j) => j.id)).toEqual([failed.id]);
      const preview = Bun.spawn(
        ['bun', 'run', 'src/scripts/analysis-retry.ts', `--chat-id=${chatId}`],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      expect(await preview.exited).toBe(0);
      expect(JSON.parse(await new Response(preview.stdout).text()).mode).toBe(
        'dry-run',
      );
      expect(
        (
          await prisma.backgroundJob.findUniqueOrThrow({
            where: { id: failed.id },
          })
        ).status,
      ).toBe('FAILED');
      const replayed = await Promise.all([
        replayFailedAnalysisJobRepo(failed),
        replayFailedAnalysisJobRepo(failed),
      ]);
      expect(replayed.filter(Boolean)).toHaveLength(1);
      const row = await prisma.backgroundJob.findUniqueOrThrow({
        where: { id: failed.id },
      });
      expect(row).toMatchObject({
        createdAt: cutoffAt,
        dedupeKey: failed.dedupeKey,
        attempts: 0,
        status: 'PENDING',
      });
      expect(row.payload).toMatchObject({
        ...window,
        replay: {
          count: 1,
          previousAttempts: 5,
          previousErrorCategory: 'timeout',
        },
      });
      const claimed = await claimNextBackgroundJobRepo('test-worker', 60_000);
      expect(claimed?.id).toBe(failed.id);
      if (!claimed) throw new Error('No claimed job');
      expect(claimed.createdAt).toEqual(cutoffAt);
      await expect(
        freezeAnalysisWindowRepo(claimed.id, 'wrong-worker', payload),
      ).rejects.toThrow();
      await freezeAnalysisWindowRepo(claimed.id, claimed.workerId, payload);
      await prisma.message.delete({ where: { chatId_id: { chatId, id: 2n } } });
      await prisma.message.update({
        where: { chatId_id: { chatId, id: 4n } },
        data: { private: true },
      });
      await prisma.message.create({ data: source(100n) });
      const available = await findAnalysisSourcesRepo({
        chatId,
        senderId: userId,
        botId,
        cutoffAt,
        ids: window.baseMessageIds.map(BigInt),
      });
      expect(available).toHaveLength(28);
      expect(available.some((m) => m.id === 100n)).toBe(false);
      expect(
        await deferAnalysisJobRepo(claimed.id, 'wrong-worker', new Date()),
      ).toBe(false);
      expect(
        await deferAnalysisJobRepo(
          claimed.id,
          claimed.workerId,
          new Date('2026-10-05T21:00:00Z'),
        ),
      ).toBe(true);
      expect(
        await prisma.backgroundJob.findUniqueOrThrow({
          where: { id: claimed.id },
        }),
      ).toMatchObject({
        status: 'PENDING',
        attempts: 0,
        payload,
        availableAt: new Date('2026-10-05T21:00:00Z'),
      });
    } finally {
      await prisma.backgroundJob.deleteMany({ where: { id: { in: ids } } });
      await prisma.message.deleteMany({
        where: { chatId: { in: [chatId, otherChat] } },
      });
      await prisma.chat.deleteMany({
        where: { id: { in: [chatId, otherChat] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [userId, authorId, botId] } },
      });
    }
  });
  test('serializes creation and contradiction, preserves latest content and vector', async () => {
    const userId = BigInt(Date.now()),
      chatId = -userId;
    const sentAt = new Date('2026-09-01T00:00:00Z');
    await prisma.user.create({ data: { id: userId } });
    await prisma.chat.create({
      data: { id: chatId, chatType: 'GROUP', title: 'Analysis isolated test' },
    });
    try {
      await prisma.message.createMany({
        data: [1n, 2n, 3n].map((id) => ({
          chatId,
          id,
          senderId: userId,
          private: false,
          text: 'source',
          messageType: 'TEXT',
          sentAt,
        })),
      });
      const create = (content = 'Москва') =>
        createUserFactRepo({
          userId,
          content,
          type: 'FACT',
          weight: 2,
          sourceChatId: chatId,
          sourceMessageId: 1n,
          embedding: Array(384).fill(0.1),
        });
      const facts = await Promise.all([create(), create()]);
      expect(facts[0].id).toBe(facts[1].id);
      const factId = facts[0].id;
      expect((await create('Любит Rust')).id).not.toBe(factId);
      const apply = (
        sourceMessageId: bigint,
        content: string,
        reason: 'duplicate' | 'contradiction' = 'contradiction',
      ) =>
        applyUserFactEvidenceRepo({
          factId,
          sourceChatId: chatId,
          sourceMessageId,
          content,
          reason,
          embedding: Array(384).fill(Number(sourceMessageId) / 10),
        });
      await Promise.all([apply(3n, 'Казань'), apply(2n, 'Пермь')]);
      const current = await prisma.userFact.findUniqueOrThrow({
        where: { id: factId },
      });
      expect(current.content).toBe('Казань');
      const vectors = await prisma.$queryRaw<
        Array<{ vector: string }>
      >`SELECT "embedding"::text AS vector FROM "UserFact" WHERE "id" = ${factId}`;
      expect(vectors[0].vector).toContain('0.3');
      const before = { ...current };
      expect(await apply(1n, 'Москва')).toBe('skipped_stale_source');
      expect(
        await prisma.userFact.findUniqueOrThrow({ where: { id: factId } }),
      ).toEqual(before);
      expect(await apply(3n, 'Казань', 'duplicate')).toBe('already_applied');
      const unknown = await prisma.userFact.create({
        data: { userId, content: 'Без источников', type: 'FACT' },
      });
      expect(
        await applyUserFactEvidenceRepo({
          factId: unknown.id,
          sourceChatId: chatId,
          sourceMessageId: 3n,
          content: 'Замена',
          reason: 'contradiction',
        }),
      ).toBe('skipped_unknown_source_order');
    } finally {
      await prisma.userFact.deleteMany({ where: { userId } });
      await prisma.message.deleteMany({ where: { chatId } });
      await prisma.chat.delete({ where: { id: chatId } });
      await prisma.user.delete({ where: { id: userId } });
    }
  });
});
