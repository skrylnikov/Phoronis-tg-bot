CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "Message"
ADD COLUMN "searchText" TEXT,
ADD COLUMN "embedding" vector(384),
ADD COLUMN "embeddingVersion" INTEGER;

ALTER TABLE "Memory"
ADD COLUMN "embedding" vector(384),
ADD COLUMN "embeddingVersion" INTEGER;

ALTER TABLE "UserFact"
ADD COLUMN "embedding" vector(384),
ADD COLUMN "embeddingVersion" INTEGER;

CREATE INDEX "Message_senderId_idx" ON "Message"("senderId");
