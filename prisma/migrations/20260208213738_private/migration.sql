-- AlterTable
ALTER TABLE "Chat" ADD COLUMN     "privateModeEnabled" BOOLEAN DEFAULT false;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "private" BOOLEAN DEFAULT false;
