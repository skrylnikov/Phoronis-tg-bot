const { describe, it, expect, vi, beforeEach } = await import('vitest');

const messageQueryRaw = vi.fn();

vi.mock('./src/db', () => ({
  prisma: {
    message: {},
    $queryRaw: messageQueryRaw,
    chat: { findUnique: vi.fn().mockResolvedValue({ privateModeEnabled: false }) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

beforeEach(() => vi.clearAllMocks());

describe('mock test', () => {
  it('checks $queryRaw mock', async () => {
    const { searchChatHistory } = await import('./src/ai/tools/chat-history.js');
    const { default: BotContext } = await import('./src/bot.js');
    
    messageQueryRaw
      .mockResolvedValueOnce([{ candidateId: 101n, rootMessageId: 101n, incomplete: true }])
      .mockResolvedValueOnce([]);
    
    const ctx = { chat: { id: -100, type: 'group' }, chatId: -100, from: { id: 123 }, msg: { message_id: 200, date: Math.floor(Date.now() / 1000) } };
    await searchChatHistory(ctx, { mode: 'search', query: 'test' });
    
    console.log('$queryRaw called:', messageQueryRaw.mock.calls.length, 'times');
    expect(messageQueryRaw).toHaveBeenCalled();
  });
});
