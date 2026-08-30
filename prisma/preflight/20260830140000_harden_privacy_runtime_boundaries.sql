-- Read-only preflight for 20260830140000_harden_privacy_runtime_boundaries.
-- Run against a recent production-like snapshot before deployment.
--
-- Expected migration locks:
-- - evidence INSERT takes RowExclusiveLock on UserFactEvidence and reads UserFact;
-- - private-context DELETE takes RowExclusiveLock on AiThreadContext and cascades events;
-- - replacing the context-event and Message self-reply FKs takes AccessExclusiveLock
--   on AiThreadContextEvent and Message.
-- Keep lock_timeout bounded and apply the migration before starting the new app.
-- PostgreSQL rolls the migration transaction back on failure. A committed private-context
-- purge is intentionally irreversible; application rollback remains schema-compatible.

BEGIN TRANSACTION READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT COUNT(*) AS evidence_backfill_candidates
FROM "UserFact"
WHERE "sourceChatId" IS NOT NULL
  AND "sourceMessageId" IS NOT NULL;

SELECT COUNT(*) AS evidence_already_present
FROM "UserFact" AS fact
JOIN "UserFactEvidence" AS evidence
  ON evidence."factId" = fact.id
 AND evidence."sourceChatId" = fact."sourceChatId"
 AND evidence."sourceMessageId" = fact."sourceMessageId"
WHERE fact."sourceChatId" IS NOT NULL
  AND fact."sourceMessageId" IS NOT NULL;

EXPLAIN (COSTS, VERBOSE)
INSERT INTO "UserFactEvidence" ("factId", "sourceChatId", "sourceMessageId")
SELECT id, "sourceChatId", "sourceMessageId"
FROM "UserFact"
WHERE "sourceChatId" IS NOT NULL
  AND "sourceMessageId" IS NOT NULL
ON CONFLICT ("factId", "sourceChatId", "sourceMessageId") DO NOTHING;

SELECT COUNT(DISTINCT thread.id) AS private_context_purge_candidates
FROM "AiThreadContext" AS thread
JOIN "AiThreadContextEvent" AS event ON event."threadId" = thread.id
JOIN "Message" AS message
  ON message."chatId" = event."messageChatId"
 AND message.id = event."messageId"
WHERE message.private = true;

SELECT COUNT(*) AS private_context_events_to_cascade
FROM "AiThreadContextEvent" AS event
JOIN "Message" AS message
  ON message."chatId" = event."messageChatId"
 AND message.id = event."messageId"
WHERE message.private = true;

EXPLAIN (COSTS, VERBOSE)
DELETE FROM "AiThreadContext" AS thread
WHERE EXISTS (
  SELECT 1
  FROM "AiThreadContextEvent" AS event
  JOIN "Message" AS message
    ON message."chatId" = event."messageChatId"
   AND message.id = event."messageId"
  WHERE event."threadId" = thread.id
    AND message.private = true
);

ROLLBACK;
