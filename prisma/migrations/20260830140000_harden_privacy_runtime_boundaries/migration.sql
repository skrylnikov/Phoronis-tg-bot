CREATE TABLE "UserFactEvidence" (
  "id" BIGSERIAL NOT NULL,
  "factId" BIGINT NOT NULL,
  "sourceChatId" BIGINT NOT NULL,
  "sourceMessageId" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "UserFactEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserFactEvidence_factId_sourceChatId_sourceMessageId_key"
ON "UserFactEvidence"("factId", "sourceChatId", "sourceMessageId");

CREATE INDEX "UserFactEvidence_sourceChatId_sourceMessageId_idx"
ON "UserFactEvidence"("sourceChatId", "sourceMessageId");

ALTER TABLE "UserFactEvidence"
ADD CONSTRAINT "UserFactEvidence_factId_fkey"
FOREIGN KEY ("factId") REFERENCES "UserFact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserFactEvidence"
ADD CONSTRAINT "UserFactEvidence_sourceChatId_sourceMessageId_fkey"
FOREIGN KEY ("sourceChatId", "sourceMessageId") REFERENCES "Message"("chatId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "UserFactEvidence" ("factId", "sourceChatId", "sourceMessageId")
SELECT "id", "sourceChatId", "sourceMessageId"
FROM "UserFact"
WHERE "sourceChatId" IS NOT NULL AND "sourceMessageId" IS NOT NULL
ON CONFLICT ("factId", "sourceChatId", "sourceMessageId") DO NOTHING;

DELETE FROM "AiThreadContext" AS thread
WHERE EXISTS (
  SELECT 1
  FROM "AiThreadContextEvent" AS event
  JOIN "Message" AS message
    ON message."chatId" = event."messageChatId"
   AND message."id" = event."messageId"
  WHERE event."threadId" = thread."id"
    AND message."private" = true
);

ALTER TABLE "AiThreadContextEvent"
DROP CONSTRAINT "AiThreadContextEvent_messageChatId_messageId_fkey";

ALTER TABLE "AiThreadContextEvent"
ADD CONSTRAINT "AiThreadContextEvent_messageChatId_messageId_fkey"
FOREIGN KEY ("messageChatId", "messageId") REFERENCES "Message"("chatId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Message" DROP CONSTRAINT "Message_replyToMessageId_chatId_fkey";

ALTER TABLE "Message"
ADD CONSTRAINT "Message_replyToMessageId_chatId_fkey"
FOREIGN KEY ("replyToMessageId", "chatId") REFERENCES "Message"("id", "chatId")
ON DELETE SET NULL ("replyToMessageId") ON UPDATE CASCADE;

CREATE INDEX "Message_private_sentAt_idx" ON "Message"("private", "sentAt");
