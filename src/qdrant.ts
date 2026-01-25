import { QdrantClient } from '@qdrant/js-client-rest';
import { qdrantApiKey, qdrantBaseURL } from './config';

export const qdrantClient = new QdrantClient({
  url: qdrantBaseURL,
  port: 443,
  apiKey: qdrantApiKey,
});
