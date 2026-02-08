import { logger } from './logger';
import { qdrantClient } from './qdrant';

export async function ensureQdrantCollections() {
  try {
    const collections = await qdrantClient.getCollections();
    const existingCollections = new Set(
      collections.collections.map((c: { name: string }) => c.name),
    );

    if (!existingCollections.has('user-facts')) {
      await qdrantClient.createCollection('user-facts', {
        vectors: {
          size: 4096,
          distance: 'Cosine',
        },
        optimizers_config: {
          indexing_threshold: 20000,
        },
      });
      logger.info('Created Qdrant collection: user-facts');
    }
  } catch (error) {
    logger.error(error, 'Error ensuring Qdrant collections');
  }
}
