DROP TABLE "FactImpact";

DROP INDEX "UserFact_impactScore_idx";
DROP INDEX "UserFact_sourceChatId_sourceMessageId_idx";

ALTER TABLE "UserFact"
DROP CONSTRAINT "UserFact_sourceChatId_sourceMessageId_fkey",
DROP CONSTRAINT "UserFact_source_message_pair_check",
DROP COLUMN "sourceChatId",
DROP COLUMN "sourceMessageId",
DROP COLUMN "usageCount",
DROP COLUMN "lastUsedAt",
DROP COLUMN "impactScore";

ALTER TABLE "User" DROP COLUMN "metaInfo";
