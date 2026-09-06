-- CreateEnum
CREATE TYPE "UserAliasStatus" AS ENUM ('CANDIDATE', 'CONFIRMED', 'REJECTED');

-- CreateTable
CREATE TABLE "UserAlias" (
    "id" BIGSERIAL NOT NULL,
    "chatId" BIGINT NOT NULL,
    "userId" BIGINT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confirmationCount" INTEGER NOT NULL DEFAULT 0,
    "status" "UserAliasStatus" NOT NULL DEFAULT 'CANDIDATE',
    "ownerConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "addressingBlocked" BOOLEAN NOT NULL DEFAULT false,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "lastOwnerMessageId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserAliasEvidence" (
    "id" BIGSERIAL NOT NULL,
    "aliasId" BIGINT NOT NULL,
    "sourceChatId" BIGINT NOT NULL,
    "sourceMessageId" BIGINT NOT NULL,
    "modelConfidence" DOUBLE PRECISION NOT NULL,
    "neutralForAddressing" BOOLEAN NOT NULL,

    CONSTRAINT "UserAliasEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserAlias_chatId_normalizedAlias_idx" ON "UserAlias"("chatId", "normalizedAlias");

-- CreateIndex
CREATE UNIQUE INDEX "UserAlias_chatId_userId_normalizedAlias_key" ON "UserAlias"("chatId", "userId", "normalizedAlias");

-- CreateIndex
CREATE INDEX "UserAliasEvidence_sourceChatId_sourceMessageId_idx" ON "UserAliasEvidence"("sourceChatId", "sourceMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "UserAliasEvidence_aliasId_sourceChatId_sourceMessageId_key" ON "UserAliasEvidence"("aliasId", "sourceChatId", "sourceMessageId");

-- AddForeignKey
ALTER TABLE "UserAlias" ADD CONSTRAINT "UserAlias_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAlias" ADD CONSTRAINT "UserAlias_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAliasEvidence" ADD CONSTRAINT "UserAliasEvidence_aliasId_fkey" FOREIGN KEY ("aliasId") REFERENCES "UserAlias"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAliasEvidence" ADD CONSTRAINT "UserAliasEvidence_sourceChatId_sourceMessageId_fkey" FOREIGN KEY ("sourceChatId", "sourceMessageId") REFERENCES "Message"("chatId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserAlias" ADD CONSTRAINT "UserAlias_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1);
ALTER TABLE "UserAlias" ADD CONSTRAINT "UserAlias_confirmationCount_check" CHECK ("confirmationCount" >= 0);
ALTER TABLE "UserAliasEvidence" ADD CONSTRAINT "UserAliasEvidence_confidence_check" CHECK ("modelConfidence" >= 0 AND "modelConfidence" <= 1);
CREATE UNIQUE INDEX "UserAlias_preferred_key" ON "UserAlias" ("chatId", "userId") WHERE "preferred" = true;
