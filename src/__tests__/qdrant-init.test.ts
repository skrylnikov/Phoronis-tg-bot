import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCollections = vi.fn();
const createCollection = vi.fn();

vi.mock('../qdrant', () => ({
  qdrantClient: { getCollections, createCollection },
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

const { ensureQdrantCollections } = await import('../qdrant-init');

describe('ensureQdrantCollections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates every missing collection with the embedding dimension', async () => {
    getCollections.mockResolvedValue({ collections: [] });
    createCollection.mockResolvedValue(true);

    await ensureQdrantCollections();

    expect(createCollection).toHaveBeenCalledTimes(3);
    for (const collection of ['messages', 'memories', 'user-facts']) {
      expect(createCollection).toHaveBeenCalledWith(
        collection,
        expect.objectContaining({
          vectors: { size: 4096, distance: 'Cosine' },
        }),
      );
    }
  });

  it('keeps existing collections unchanged', async () => {
    getCollections.mockResolvedValue({
      collections: [
        { name: 'messages' },
        { name: 'memories' },
        { name: 'user-facts' },
      ],
    });

    await ensureQdrantCollections();

    expect(createCollection).not.toHaveBeenCalled();
  });

  it('fails startup when Qdrant cannot be initialized', async () => {
    const error = new Error('qdrant unavailable');
    getCollections.mockRejectedValue(error);

    await expect(ensureQdrantCollections()).rejects.toBe(error);
  });
});
