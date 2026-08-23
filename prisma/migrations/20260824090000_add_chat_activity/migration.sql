ALTER TABLE "Chat"
ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "inactiveSince" TIMESTAMP(3);

CREATE INDEX "Message_chatId_sentAt_idx" ON "Message"("chatId", "sentAt");
