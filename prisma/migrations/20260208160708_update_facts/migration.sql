-- CreateEnum
CREATE TYPE "FactType" AS ENUM ('TEXT_STYLE', 'FACT', 'INTEREST', 'NEGATIVE_INTEREST');

-- CreateTable
CREATE TABLE "UserFact" (
    "id" BIGSERIAL NOT NULL,
    "userId" BIGINT NOT NULL,
    "content" TEXT NOT NULL,
    "type" "FactType" NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "sourceMessageId" BIGINT,
    "expiresAt" TIMESTAMP(3),
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "impactScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactImpact" (
    "id" BIGSERIAL NOT NULL,
    "factId" BIGINT NOT NULL,
    "usedInMessageId" BIGINT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userReaction" TEXT,
    "messageReaction" TEXT,

    CONSTRAINT "FactImpact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactHistory" (
    "id" BIGSERIAL NOT NULL,
    "factId" BIGINT NOT NULL,
    "previousContent" TEXT NOT NULL,
    "newContent" TEXT NOT NULL,
    "weightChange" INTEGER NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,

    CONSTRAINT "FactHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserFact_userId_type_idx" ON "UserFact"("userId", "type");

-- CreateIndex
CREATE INDEX "UserFact_userId_updatedAt_idx" ON "UserFact"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "UserFact_expiresAt_idx" ON "UserFact"("expiresAt");

-- CreateIndex
CREATE INDEX "UserFact_impactScore_idx" ON "UserFact"("impactScore");

-- CreateIndex
CREATE INDEX "FactImpact_factId_idx" ON "FactImpact"("factId");

-- CreateIndex
CREATE INDEX "FactImpact_usedInMessageId_idx" ON "FactImpact"("usedInMessageId");

-- CreateIndex
CREATE INDEX "FactImpact_timestamp_idx" ON "FactImpact"("timestamp");

-- CreateIndex
CREATE INDEX "FactHistory_factId_idx" ON "FactHistory"("factId");

-- AddForeignKey
ALTER TABLE "UserFact" ADD CONSTRAINT "UserFact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactImpact" ADD CONSTRAINT "FactImpact_factId_fkey" FOREIGN KEY ("factId") REFERENCES "UserFact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactHistory" ADD CONSTRAINT "FactHistory_factId_fkey" FOREIGN KEY ("factId") REFERENCES "UserFact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
