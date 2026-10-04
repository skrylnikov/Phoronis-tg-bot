CREATE TABLE "DecisionReview" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "sourceChatId" BIGINT NOT NULL,
    "sourceMessageId" BIGINT NOT NULL,
    "candidate" TEXT NOT NULL,
    "candidateType" TEXT,
    "requestedModel" TEXT NOT NULL,
    "actualModel" TEXT,
    "policyVersion" INTEGER NOT NULL,
    "scores" JSONB NOT NULL,
    "thresholds" JSONB NOT NULL,
    "comparison" JSONB,
    "outcome" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resultId" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DecisionReview_createdAt_idx" ON "DecisionReview"("createdAt");
CREATE INDEX "DecisionReview_sourceChatId_createdAt_idx" ON "DecisionReview"("sourceChatId", "createdAt");
CREATE INDEX "DecisionReview_runId_idx" ON "DecisionReview"("runId");
ALTER TABLE "DecisionReview" ADD CONSTRAINT "DecisionReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionReview" ADD CONSTRAINT "DecisionReview_sourceChatId_sourceMessageId_fkey" FOREIGN KEY ("sourceChatId", "sourceMessageId") REFERENCES "Message"("chatId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
