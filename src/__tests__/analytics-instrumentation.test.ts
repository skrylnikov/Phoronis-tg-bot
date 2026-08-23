import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  embedQuery: vi.fn(),
  recordVectorSearch: vi.fn(),
  searchChatMessageContext: vi.fn(),
  searchUserMessageContext: vi.fn(),
}));

vi.mock('../ai/embedding/client', () => ({ embedQuery: mocks.embedQuery }));
vi.mock('../ai/embedding/backfill', () => ({
  requestEmbeddingBackfill: vi.fn(),
}));
vi.mock('../ai/embedding/store', () => ({
  searchChatMessageContext: mocks.searchChatMessageContext,
  searchUserMessageContext: mocks.searchUserMessageContext,
  updateMessageEmbedding: vi.fn(),
}));
vi.mock('../analytics-runtime', () => ({
  recordVectorSearch: mocks.recordVectorSearch,
}));
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import { searchContext } from '../ai/embedding';

beforeEach(() => vi.clearAllMocks());

describe('vector analytics instrumentation', () => {
  it('records the exact number of context messages returned by both searches', async () => {
    mocks.embedQuery.mockResolvedValue([0.1]);
    mocks.searchUserMessageContext.mockResolvedValue(['user context']);
    mocks.searchChatMessageContext.mockResolvedValue([
      'chat context 1',
      'chat context 2',
    ]);

    await searchContext('A sufficiently long search query', 1, 2, false);

    expect(mocks.recordVectorSearch).toHaveBeenCalledWith(3);
  });

  it('does not include excluded privacy paths in runtime counters', async () => {
    mocks.embedQuery.mockResolvedValue([0.1]);
    mocks.searchUserMessageContext.mockResolvedValue(['context']);
    mocks.searchChatMessageContext.mockResolvedValue([]);

    await searchContext('A sufficiently long search query', 1, 2, false, false);

    expect(mocks.recordVectorSearch).not.toHaveBeenCalled();
  });
});
