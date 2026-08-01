-- Add an unambiguous reference to the message that supports a fact.
ALTER TABLE "UserFact"
ADD COLUMN "sourceChatId" BIGINT;

ALTER TABLE "UserFact"
ADD CONSTRAINT "UserFact_source_message_pair_check"
CHECK (("sourceChatId" IS NULL) = ("sourceMessageId" IS NULL));

ALTER TABLE "UserFact"
ADD CONSTRAINT "UserFact_sourceChatId_sourceMessageId_fkey"
FOREIGN KEY ("sourceChatId", "sourceMessageId")
REFERENCES "Message" ("chatId", "id")
ON DELETE SET NULL
ON UPDATE CASCADE;

CREATE INDEX "UserFact_sourceChatId_sourceMessageId_idx"
ON "UserFact"("sourceChatId", "sourceMessageId");
