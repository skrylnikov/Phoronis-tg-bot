import { describe, expect, test } from 'bun:test';
import { prisma } from '../db';
import {
  countPaidOrders,
  createLimitNotice,
  createPurchaseSessionRepo,
  findActiveUserSubscriptions,
  findChatById,
  findPurchaseSession,
  findQuotaUsages,
  releaseQuotaUsage,
  reserveQuotaUsage,
  saveChat,
  saveMessage,
  saveUser,
  updateLimitNotice,
} from '../repositories';

describe('User Repository', () => {
  test('saveUser creates or updates user', async () => {
    const userId = BigInt(Date.now());
    await saveUser({
      id: Number(userId),
      is_bot: false,
      first_name: 'Test',
      username: 'testuser',
    });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user).toBeDefined();
    expect(user?.firstName).toBe('Test');
  });
});

describe('Chat Repository', () => {
  test('saveChat creates or updates chat', async () => {
    const chatId = BigInt(Date.now());
    await saveChat({
      id: Number(chatId),
      type: 'private',
      first_name: 'Test Chat',
    });

    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    expect(chat).toBeDefined();
  });

  test('findChatById returns chat title', async () => {
    const chatId = BigInt(Date.now());
    await prisma.chat.create({
      data: { id: chatId, title: 'Test Group', chatType: 'GROUP' },
    });

    const chat = await findChatById(chatId);
    expect(chat?.title).toBe('Test Group');
  });
});

describe('Message Repository', () => {
  test('saveMessage creates message', async () => {
    const userId = BigInt(Date.now());
    const chatId = BigInt(Date.now() + 1);
    const messageId = Date.now();

    await prisma.user.create({
      data: { id: userId, firstName: 'Test' },
    });
    await prisma.chat.create({
      data: { id: chatId, title: 'Test', chatType: 'PRIVATE' },
    });

    await saveMessage({
      id: BigInt(messageId),
      senderId: userId,
      chatId,
      sentAt: new Date(),
      messageType: 'TEXT',
      text: 'Test message',
    });

    const message = await prisma.message.findUnique({
      where: { chatId_id: { chatId, id: BigInt(messageId) } },
    });
    expect(message).toBeDefined();
    expect(message?.text).toBe('Test message');
  });
});

describe('Subscription Repository', () => {
  test('findActiveUserSubscriptions returns active subscriptions', async () => {
    const userId = BigInt(Date.now());
    const now = new Date();
    const startsAt = new Date(now.getTime() - 1000);
    const endsAt = new Date(now.getTime() + 1000);

    await prisma.user.create({ data: { id: userId, firstName: 'Test' } });
    await prisma.subscription.create({
      data: {
        userId,
        beneficiaryChatId: -100n,
        plan: 'MONTH',
        startsAt,
        endsAt,
      },
    });

    const subs = await findActiveUserSubscriptions(userId, now);
    expect(subs.length).toBe(1);
    expect(subs[0].plan).toBe('MONTH');
  });

  test('createPurchaseSessionRepo creates session with token', async () => {
    const userId = BigInt(Date.now());
    const chatId = BigInt(Date.now() + 1);
    const expiresAt = new Date(Date.now() + 60000);

    await prisma.user.create({ data: { id: userId, firstName: 'Test' } });
    await prisma.chat.create({
      data: { id: chatId, title: 'Test', chatType: 'PRIVATE' },
    });

    const session = await createPurchaseSessionRepo(userId, chatId, expiresAt);
    expect(session.token).toBeDefined();
    expect(session.userId).toBe(userId);
    expect(session.beneficiaryChatId).toBe(chatId);
  });

  test('findPurchaseSession retrieves session by token', async () => {
    const userId = BigInt(Date.now());
    const chatId = BigInt(Date.now() + 1);
    const expiresAt = new Date(Date.now() + 60000);

    await prisma.user.create({ data: { id: userId, firstName: 'Test' } });
    await prisma.chat.create({
      data: { id: chatId, title: 'Test', chatType: 'PRIVATE' },
    });

    const created = await createPurchaseSessionRepo(userId, chatId, expiresAt);
    const found = await findPurchaseSession(created.token);

    expect(found).toBeDefined();
    expect(found?.userId).toBe(userId);
  });

  test('countPaidOrders returns correct count', async () => {
    const userId = BigInt(Date.now());
    await prisma.user.create({ data: { id: userId, firstName: 'Test' } });

    const count1 = await countPaidOrders(userId);
    expect(count1).toBe(0);

    await prisma.paymentOrder.create({
      data: {
        userId,
        beneficiaryChatId: -100n,
        plan: 'WEEK',
        baseAmount: 49,
        amount: 39,
        discountPercent: 20,
        termsAcceptedAt: new Date(),
        termsVersion: '2026-07-28',
        status: 'PAID',
        expiresAt: new Date(Date.now() + 60000),
      },
    });

    const count2 = await countPaidOrders(userId);
    expect(count2).toBe(1);
  });
});

describe('Quota Repository', () => {
  test('reserveQuotaUsage reserves quota correctly', async () => {
    const userId = BigInt(Date.now());
    const chatId = 0n;
    const day = new Date();
    const limit = 5;

    const reserved1 = await reserveQuotaUsage(
      'USER',
      userId,
      chatId,
      'PRIMARY_RESPONSE',
      day,
      limit,
    );
    expect(reserved1).toBe(true);

    const usages = await findQuotaUsages(userId, undefined, day);
    const usage = usages.find(
      (u) => u.kind === 'PRIMARY_RESPONSE' && u.scope === 'USER',
    );
    expect(usage?.count).toBe(1);
  });

  test('releaseQuotaUsage decrements count', async () => {
    const userId = BigInt(Date.now());
    const chatId = 0n;
    const day = new Date();

    await reserveQuotaUsage('USER', userId, chatId, 'IMAGE', day, 10);
    let usages = await findQuotaUsages(userId, undefined, day);
    let usage = usages.find((u) => u.kind === 'IMAGE' && u.scope === 'USER');
    expect(usage?.count).toBe(1);

    await releaseQuotaUsage('USER', userId, chatId, 'IMAGE', day);
    usages = await findQuotaUsages(userId, undefined, day);
    usage = usages.find((u) => u.kind === 'IMAGE' && u.scope === 'USER');
    expect(usage?.count).toBe(0);
  });

  test('updateLimitNotice updates existing notice', async () => {
    const userId = BigInt(Date.now());
    const chatId = BigInt(Date.now() + 1);
    const now = new Date();
    const cutoff = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

    await prisma.user.create({ data: { id: userId, firstName: 'Test' } });
    await prisma.chat.create({
      data: { id: chatId, title: 'Test', chatType: 'PRIVATE' },
    });
    await createLimitNotice(userId, chatId, 'IMAGE_LIMIT', cutoff);

    const result = await updateLimitNotice(
      userId,
      chatId,
      'IMAGE_LIMIT',
      cutoff,
      now,
    );
    expect(result.count).toBe(1);
  });
});
