-- Keep quota usage distinct for every user in every group.
ALTER TABLE "QuotaUsage" ADD COLUMN "chatId" BIGINT NOT NULL DEFAULT 0;

DROP INDEX "QuotaUsage_scope_ownerId_kind_date_key";

CREATE UNIQUE INDEX "QuotaUsage_scope_ownerId_chatId_kind_date_key"
ON "QuotaUsage"("scope", "ownerId", "chatId", "kind", "date");

-- Give active buyers a fresh personal quota on the release day. Old shared chat
-- usage cannot be attributed fairly, so reset it for groups with subscriptions.
DELETE FROM "QuotaUsage"
WHERE "date" = (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date
  AND (
    (
      "scope" = 'USER'
      AND "ownerId" IN (
        SELECT "userId"
        FROM "Subscription"
        WHERE "startsAt" <= CURRENT_TIMESTAMP
          AND "endsAt" > CURRENT_TIMESTAMP
          AND "revokedAt" IS NULL
      )
    )
    OR (
      "scope" = 'CHAT'
      AND "ownerId" IN (
        SELECT "beneficiaryChatId"
        FROM "Subscription"
        WHERE "startsAt" <= CURRENT_TIMESTAMP
          AND "endsAt" > CURRENT_TIMESTAMP
          AND "revokedAt" IS NULL
      )
    )
  );
