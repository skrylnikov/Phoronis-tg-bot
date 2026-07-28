-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('WEEK', 'MONTH', 'QUARTER', 'YEAR');

-- CreateEnum
CREATE TYPE "PaymentOrderStatus" AS ENUM ('PENDING', 'PAID', 'REFUNDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "QuotaScope" AS ENUM ('USER', 'CHAT');

-- CreateEnum
CREATE TYPE "QuotaKind" AS ENUM ('PRIMARY_RESPONSE', 'IMAGE', 'VOICE', 'ANALYSIS');

-- CreateEnum
CREATE TYPE "LimitNoticeKind" AS ENUM ('LITE_FALLBACK', 'IMAGE_LIMIT', 'VOICE_LIMIT');

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "beneficiaryChatId" BIGINT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentOrder" (
    "id" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "beneficiaryChatId" BIGINT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "baseAmount" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "discountPercent" INTEGER NOT NULL DEFAULT 0,
    "status" "PaymentOrderStatus" NOT NULL DEFAULT 'PENDING',
    "termsAcceptedAt" TIMESTAMP(3) NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "telegramPaymentChargeId" TEXT,
    "subscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseSession" (
    "token" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "beneficiaryChatId" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "termsAcceptedAt" TIMESTAMP(3),
    "termsVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseSession_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "QuotaUsage" (
    "id" TEXT NOT NULL,
    "scope" "QuotaScope" NOT NULL,
    "ownerId" BIGINT NOT NULL,
    "kind" "QuotaKind" NOT NULL,
    "date" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "QuotaUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LimitNotice" (
    "id" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "kind" "LimitNoticeKind" NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LimitNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Subscription_userId_endsAt_idx" ON "Subscription"("userId", "endsAt");
CREATE INDEX "Subscription_beneficiaryChatId_endsAt_idx" ON "Subscription"("beneficiaryChatId", "endsAt");
CREATE UNIQUE INDEX "PaymentOrder_telegramPaymentChargeId_key" ON "PaymentOrder"("telegramPaymentChargeId");
CREATE UNIQUE INDEX "PaymentOrder_subscriptionId_key" ON "PaymentOrder"("subscriptionId");
CREATE INDEX "PaymentOrder_userId_status_idx" ON "PaymentOrder"("userId", "status");
CREATE INDEX "PaymentOrder_beneficiaryChatId_status_idx" ON "PaymentOrder"("beneficiaryChatId", "status");
CREATE INDEX "PaymentOrder_status_expiresAt_idx" ON "PaymentOrder"("status", "expiresAt");
CREATE UNIQUE INDEX "QuotaUsage_scope_ownerId_kind_date_key" ON "QuotaUsage"("scope", "ownerId", "kind", "date");
CREATE UNIQUE INDEX "LimitNotice_userId_chatId_kind_key" ON "LimitNotice"("userId", "chatId", "kind");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_beneficiaryChatId_fkey" FOREIGN KEY ("beneficiaryChatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_beneficiaryChatId_fkey" FOREIGN KEY ("beneficiaryChatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PurchaseSession" ADD CONSTRAINT "PurchaseSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseSession" ADD CONSTRAINT "PurchaseSession_beneficiaryChatId_fkey" FOREIGN KEY ("beneficiaryChatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LimitNotice" ADD CONSTRAINT "LimitNotice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LimitNotice" ADD CONSTRAINT "LimitNotice_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
