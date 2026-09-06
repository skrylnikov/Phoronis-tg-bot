import { describe, expect, test } from 'bun:test';
import { prisma } from '../db';
import {
  findUserAliasesRepo,
  saveUserAliasEvidenceRepo,
  setMyAliasRepo,
} from '../repositories/user-alias-repository';

describe('chat user alias constraints', () => {
  test('serializes learning and owner commands, survives retries and source cleanup', async () => {
    const userId = BigInt(Date.now());
    const authorId = userId + 1n;
    const chatId = -userId;
    await prisma.user.createMany({ data: [{ id: userId }, { id: authorId }] });
    await prisma.chat.create({
      data: { id: chatId, title: 'Alias concurrency', chatType: 'GROUP' },
    });
    const save = (sourceMessageId: bigint, modelConfidence = 0.8) =>
      saveUserAliasEvidenceRepo({
        chatId,
        userId,
        sourceMessageId,
        alias: 'Шурик',
        modelConfidence,
        neutralForAddressing: true,
        botId: 999n,
      });
    const command = (
      messageId: bigint,
      alias: string,
      action: 'prefer' | 'avoid_addressing' | 'reject_identity' = 'prefer',
    ) => setMyAliasRepo({ chatId, userId, messageId, alias, action });
    try {
      await prisma.message.create({
        data: {
          chatId,
          id: 1n,
          senderId: userId,
          text: 'Привет',
          messageType: 'TEXT',
          sentAt: new Date(),
          private: false,
        },
      });
      for (let i = 0; i < 5; i++)
        await prisma.message.create({
          data: {
            chatId,
            id: BigInt(i + 2),
            senderId: i % 2 ? userId : authorId,
            replyToMessageId: 1n,
            text: 'Шурик, привет',
            messageType: 'TEXT',
            sentAt: new Date(Date.UTC(2026, 8, i + 1)),
            private: false,
          },
        });
      await Promise.all([
        save(2n),
        save(2n),
        save(3n),
        save(4n),
        save(5n),
        save(6n),
      ]);
      await save(2n, 1);
      let rows = await findUserAliasesRepo(chatId, userId);
      expect(rows[0]?.confidence).toBeCloseTo(0.91808, 10);
      expect(rows[0]?.confirmationCount).toBe(5);
      await prisma.message.delete({ where: { chatId_id: { chatId, id: 6n } } });
      expect(
        (await findUserAliasesRepo(chatId, userId))[0]?.confidence,
      ).toBeCloseTo(0.8976, 10);
      await Promise.all([command(100n, 'Шурик'), command(101n, 'Саша')]);
      await command(100n, 'Шурик');
      rows = await findUserAliasesRepo(chatId, userId);
      expect(
        rows.filter((row) => row.preferred).map((row) => row.alias),
      ).toEqual(['Саша']);
      await command(102n, 'Шурик', 'reject_identity');
      await save(2n);
      expect(
        (await findUserAliasesRepo(chatId, userId)).find(
          (row) => row.alias === 'Шурик',
        )?.status,
      ).toBe('REJECTED');
      await command(103n, 'Шурик');
      await command(104n, 'Шурик', 'avoid_addressing');
      expect(
        (await findUserAliasesRepo(chatId, userId)).find(
          (row) => row.alias === 'Шурик',
        ),
      ).toMatchObject({
        status: 'CONFIRMED',
        addressingBlocked: true,
        preferred: false,
      });
      await command(105n, 'Незнакомый', 'avoid_addressing');
      expect(
        (await findUserAliasesRepo(chatId, userId)).find(
          (row) => row.alias === 'Незнакомый',
        )?.status,
      ).toBe('CANDIDATE');
      await prisma.message.create({
        data: {
          chatId,
          id: 106n,
          senderId: userId,
          text: 'Называй меня Алекс',
          private: true,
          messageType: 'TEXT',
          sentAt: new Date(),
        },
      });
      await command(106n, 'Алекс');
      await prisma.message.deleteMany({ where: { chatId } });
      expect(
        (await findUserAliasesRepo(chatId, userId)).find(
          (row) => row.alias === 'Алекс',
        ),
      ).toMatchObject({ preferred: true, confidence: 1 });
    } finally {
      await prisma.message.deleteMany({ where: { chatId } });
      await prisma.chat.delete({ where: { id: chatId } });
      await prisma.user.deleteMany({
        where: { id: { in: [userId, authorId] } },
      });
    }
  });
  test('rejects invalid ratings, duplicate sources and preferences; cascades sources', async () => {
    const userId = BigInt(Date.now());
    const chatId = -userId;
    await prisma.user.create({ data: { id: userId } });
    await prisma.chat.create({
      data: { id: chatId, title: 'Aliases test', chatType: 'GROUP' },
    });
    try {
      const data = {
        userId,
        chatId,
        alias: 'Саша',
        normalizedAlias: 'саша',
        preferred: true,
      };
      const alias = await prisma.userAlias.create({ data });
      await expect(
        prisma.userAlias.create({ data }).then((value) => value),
      ).rejects.toThrow();
      await expect(
        prisma.userAlias
          .create({
            data: { ...data, alias: 'Шурик', normalizedAlias: 'шурик' },
          })
          .then((value) => value),
      ).rejects.toThrow();
      for (const confidence of [
        -0.1,
        1.1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        await expect(
          prisma.userAlias
            .update({ where: { id: alias.id }, data: { confidence } })
            .then((value) => value),
        ).rejects.toThrow();
      }
      await prisma.message.create({
        data: {
          id: 1n,
          chatId,
          senderId: userId,
          messageType: 'TEXT',
          sentAt: new Date(),
        },
      });
      const evidence = {
        aliasId: alias.id,
        sourceChatId: chatId,
        sourceMessageId: 1n,
        modelConfidence: 0.8,
        neutralForAddressing: true,
      };
      for (const modelConfidence of [-0.1, 1.1, Number.NaN]) {
        await expect(
          prisma.userAliasEvidence
            .create({ data: { ...evidence, modelConfidence } })
            .then((value) => value),
        ).rejects.toThrow();
      }
      await expect(
        prisma.userAliasEvidence
          .create({ data: { ...evidence, sourceMessageId: 2n } })
          .then((value) => value),
      ).rejects.toThrow();
      await prisma.userAliasEvidence.create({ data: evidence });
      await expect(
        prisma.userAliasEvidence
          .create({ data: evidence })
          .then((value) => value),
      ).rejects.toThrow();
      await prisma.message.delete({ where: { chatId_id: { chatId, id: 1n } } });
      expect(
        await prisma.userAliasEvidence.count({ where: { aliasId: alias.id } }),
      ).toBe(0);
      expect(await prisma.userAlias.count({ where: { id: alias.id } })).toBe(1);
    } finally {
      await prisma.message.deleteMany({ where: { chatId } });
      await prisma.chat.delete({ where: { id: chatId } });
      await prisma.user.delete({ where: { id: userId } });
    }
  });
});
