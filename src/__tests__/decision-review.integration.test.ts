import { describe, expect, test } from 'bun:test';
import { prisma } from '../db';
import { formatDecisionReport } from '../domain/user/decision-report';
import {
  cleanDecisionReviewsRepo,
  createDecisionReviewRepo,
  finishDecisionReviewRepo,
  readDecisionReviewReportRepo,
} from '../repositories/decision-review-repository';

const databaseURL = new URL(
  process.env.DATABASE_URL || 'postgresql://localhost/unconfigured',
);
const isolatedDatabase =
  process.env.RUN_JEV_DB_TESTS === '1' &&
  databaseURL.hostname === '127.0.0.1' &&
  databaseURL.pathname === '/phoronis_jev_test';

describe.skipIf(!isolatedDatabase)(
  'decision journal on an isolated PostgreSQL database',
  () => {
    test('persists actions, excludes private and stale sources, and cascades deletion', async () => {
      const authorId = BigInt(Date.now());
      const targetId = authorId + 1n;
      const botId = authorId + 2n;
      const chatId = -authorId;
      const now = new Date();
      await prisma.user.createMany({
        data: [{ id: authorId }, { id: targetId }, { id: botId }],
      });
      await prisma.chat.create({
        data: { id: chatId, title: 'Jev isolated test', chatType: 'GROUP' },
      });
      const review = (sourceMessageId: bigint) => ({
        runId: 'test-run',
        kind: 'alias',
        userId: targetId,
        sourceChatId: chatId,
        sourceMessageId,
        candidate: 'Саша',
        requestedModel: 'typesafe/jev-1.13',
        actualModel: 'typesafe/jev-1.13-test',
        policyVersion: 1,
        scores: { support: 0.01, addressing: 0.99 },
        thresholds: { accept: 0.9, reject: 0.1 },
        outcome: 'rejected',
        action: 'skipped',
        durationMs: 123,
      });
      try {
        await prisma.message.createMany({
          data: [
            {
              chatId,
              id: 1n,
              senderId: authorId,
              messageType: 'TEXT',
              sentAt: now,
              private: false,
              text: 'Передай Саше привет',
            },
            {
              chatId,
              id: 2n,
              senderId: authorId,
              messageType: 'TEXT',
              sentAt: now,
              private: true,
              text: 'PRIVATE SECRET',
            },
            {
              chatId,
              id: 3n,
              senderId: botId,
              messageType: 'TEXT',
              sentAt: now,
              private: false,
              text: 'BOT SOURCE',
            },
            {
              chatId,
              id: 4n,
              senderId: authorId,
              messageType: 'TEXT',
              sentAt: now,
              private: false,
              text: 'Public source to remove',
            },
            {
              chatId,
              id: 5n,
              senderId: authorId,
              messageType: 'TEXT',
              sentAt: now,
              private: false,
              text: 'Public reply',
              replyToMessageId: 2n,
            },
          ],
        });
        expect(
          await createDecisionReviewRepo(review(2n), botId),
        ).toBeUndefined();
        expect(
          await createDecisionReviewRepo(review(3n), botId),
        ).toBeUndefined();
        const id = await createDecisionReviewRepo(review(1n), botId);
        expect(id).toBeDefined();
        if (!id) throw new Error('Expected a stored public review');
        await finishDecisionReviewRepo(id, 'reviewed', '200');
        const stale = await createDecisionReviewRepo(
          {
            ...review(1n),
            createdAt: new Date(now.getTime() - 8 * 86_400_000),
          },
          botId,
        );
        await createDecisionReviewRepo(review(5n), botId);
        let report = await readDecisionReviewReportRepo({
          days: 3,
          limit: 30,
          chatId,
        });
        expect(report.total).toBe(2);
        expect(report.examples.some((row) => row.id === stale)).toBe(false);
        expect(report.examples.find((row) => row.id === id)?.action).toBe(
          'reviewed',
        );
        const output = formatDecisionReport(report);
        expect(output).toContain('Передай Саше привет');
        expect(output).toContain('Кандидат: Саша');
        expect(output).not.toContain('PRIVATE SECRET');
        expect(output).not.toContain('BOT SOURCE');
        expect(report.latency.averageMs).toBe(123);
        expect(await cleanDecisionReviewsRepo()).toBe(1);
        const removed = await createDecisionReviewRepo(review(4n), botId);
        if (!removed) throw new Error('Expected a stored public review');
        await prisma.message.delete({
          where: { chatId_id: { chatId, id: 4n } },
        });
        expect(
          await prisma.decisionReview.findUnique({ where: { id: removed } }),
        ).toBeNull();
        await prisma.user.delete({ where: { id: targetId } });
        report = await readDecisionReviewReportRepo({
          days: 3,
          limit: 30,
          chatId,
        });
        expect(report.total).toBe(0);
      } finally {
        await prisma.message.deleteMany({ where: { chatId } });
        await prisma.chat.delete({ where: { id: chatId } });
        await prisma.user.deleteMany({
          where: { id: { in: [authorId, targetId, botId] } },
        });
      }
    });
  },
);
