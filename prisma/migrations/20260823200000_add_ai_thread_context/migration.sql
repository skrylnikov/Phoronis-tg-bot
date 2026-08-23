CREATE TYPE "AiThreadContextEventKind" AS ENUM (
  'INITIAL_CONTEXT',
  'RETRIEVAL',
  'USER_CONTEXT',
  'TURN_CONTEXT',
  'CORRECTION',
  'USER_MESSAGE',
  'ASSISTANT',
  'LEGACY_HISTORY',
  'CACHE_BOUNDARY'
);

CREATE TABLE "AiThreadContext" (
  "id" TEXT NOT NULL,
  "chatId" BIGINT NOT NULL,
  "rootMessageId" BIGINT,
  "promptVersion" INTEGER NOT NULL,
  "promptHash" TEXT NOT NULL,
  "rules" JSONB NOT NULL,
  "cacheBoundary" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiThreadContext_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiThreadContextEvent" (
  "id" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "turnId" TEXT NOT NULL,
  "eventKind" "AiThreadContextEventKind" NOT NULL,
  "messageChatId" BIGINT,
  "messageId" BIGINT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiThreadContextEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiThreadContext_chatId_updatedAt_idx" ON "AiThreadContext"("chatId", "updatedAt");
CREATE INDEX "AiThreadContext_chatId_rootMessageId_idx" ON "AiThreadContext"("chatId", "rootMessageId");
CREATE UNIQUE INDEX "AiThreadContextEvent_threadId_sequence_key" ON "AiThreadContextEvent"("threadId", "sequence");
CREATE UNIQUE INDEX "AiThreadContextEvent_threadId_turnId_eventKind_key" ON "AiThreadContextEvent"("threadId", "turnId", "eventKind");
CREATE INDEX "AiThreadContextEvent_threadId_createdAt_idx" ON "AiThreadContextEvent"("threadId", "createdAt");
CREATE INDEX "AiThreadContextEvent_messageChatId_messageId_idx" ON "AiThreadContextEvent"("messageChatId", "messageId");

ALTER TABLE "AiThreadContext"
ADD CONSTRAINT "AiThreadContext_chatId_fkey"
FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiThreadContextEvent"
ADD CONSTRAINT "AiThreadContextEvent_threadId_fkey"
FOREIGN KEY ("threadId") REFERENCES "AiThreadContext"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiThreadContextEvent"
ADD CONSTRAINT "AiThreadContextEvent_messageChatId_messageId_fkey"
FOREIGN KEY ("messageChatId", "messageId") REFERENCES "Message"("chatId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
