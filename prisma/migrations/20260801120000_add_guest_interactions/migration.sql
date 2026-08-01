-- CreateEnum
CREATE TYPE "GuestInteractionStatus" AS ENUM ('PROCESSING', 'ANSWERED', 'FAILED');

-- CreateTable
CREATE TABLE "GuestInteraction" (
    "id" TEXT NOT NULL,
    "guestQueryId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "userId" BIGINT NOT NULL,
    "messageId" BIGINT,
    "query" TEXT NOT NULL,
    "referenceText" TEXT,
    "answer" TEXT,
    "status" "GuestInteractionStatus" NOT NULL DEFAULT 'PROCESSING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "GuestInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuestInteraction_guestQueryId_key" ON "GuestInteraction"("guestQueryId");
CREATE INDEX "GuestInteraction_chatId_createdAt_idx" ON "GuestInteraction"("chatId", "createdAt");
CREATE INDEX "GuestInteraction_userId_createdAt_idx" ON "GuestInteraction"("userId", "createdAt");
CREATE INDEX "GuestInteraction_status_updatedAt_idx" ON "GuestInteraction"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "GuestInteraction" ADD CONSTRAINT "GuestInteraction_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GuestInteraction" ADD CONSTRAINT "GuestInteraction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
