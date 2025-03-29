-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "sessionId" TEXT;

-- CreateIndex
CREATE INDEX "Message_sessionId_idx" ON "Message"("sessionId");
