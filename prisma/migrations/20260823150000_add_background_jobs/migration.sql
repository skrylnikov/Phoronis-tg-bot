CREATE TYPE "BackgroundJobType" AS ENUM (
    'PAYMENT_BUYER_NOTIFICATION',
    'PAYMENT_BENEFICIARY_NOTIFICATION',
    'PAYMENT_ANALYTICS_NOTIFICATION',
    'USER_MESSAGE_ANALYSIS'
);

CREATE TYPE "BackgroundJobStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'COMPLETED',
    'FAILED'
);

CREATE TABLE "BackgroundJob" (
    "id" TEXT NOT NULL,
    "type" "BackgroundJobType" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "BackgroundJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "workerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,

    CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BackgroundJob_dedupeKey_key" ON "BackgroundJob"("dedupeKey");
CREATE INDEX "BackgroundJob_status_availableAt_createdAt_idx" ON "BackgroundJob"("status", "availableAt", "createdAt");
CREATE INDEX "BackgroundJob_status_leaseUntil_idx" ON "BackgroundJob"("status", "leaseUntil");
