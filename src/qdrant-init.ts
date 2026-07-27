import { logger } from './logger';
import { qdrantClient } from './qdrant';

const VECTOR_SIZE = 4096;
const COLLECTIONS = ['messages', 'memories', 'user-facts'] as const;

export async function ensureQdrantCollections() {
  try {
    const collections = await qdrantClient.getCollections();
    const existingCollections = new Set(
      collections.collections.map((c: { name: string }) => c.name),
    );

    for (const collection of COLLECTIONS) {
      if (!existingCollections.has(collection)) {
        await qdrantClient.createCollection(collection, {
          vectors: {
            size: VECTOR_SIZE,
            distance: 'Cosine',
          },
          optimizers_config: {
            indexing_threshold: 20000,
          },
        });
        logger.info({ collection }, 'Created Qdrant collection');
      }
    }
  } catch (error) {
    logger.error(error, 'Error ensuring Qdrant collections');
    throw error;
  }
}
