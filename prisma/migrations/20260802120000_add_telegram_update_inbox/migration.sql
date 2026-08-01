CREATE TYPE "TelegramUpdateLane" AS ENUM ('NORMAL', 'URGENT');

CREATE TYPE "TelegramUpdateStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "TelegramUpdate" (
    "updateId" BIGINT NOT NULL,
    "payload" JSONB NOT NULL,
    "partitionKey" TEXT NOT NULL,
    "lane" "TelegramUpdateLane" NOT NULL DEFAULT 'NORMAL',
    "status" "TelegramUpdateStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "workerId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "TelegramUpdate_pkey" PRIMARY KEY ("updateId")
);

CREATE INDEX "TelegramUpdate_status_lane_availableAt_updateId_idx"
ON "TelegramUpdate"("status", "lane", "availableAt", "updateId");

CREATE INDEX "TelegramUpdate_partitionKey_lane_updateId_status_idx"
ON "TelegramUpdate"("partitionKey", "lane", "updateId", "status");
