import { QdrantClient } from "@qdrant/js-client-rest";
import { qdrantBaseURL, qdrantApiKey } from "./config";

export const qdrantClient = new QdrantClient({
  url: qdrantBaseURL,
  port: 443,
  apiKey: qdrantApiKey,
});
