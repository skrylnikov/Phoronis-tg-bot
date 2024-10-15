/*
  Warnings:

  - The primary key for the `Message` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_replyToMessageId_fkey";

-- AlterTable
ALTER TABLE "Message" DROP CONSTRAINT "Message_pkey",
ADD CONSTRAINT "Message_pkey" PRIMARY KEY ("chatId", "id");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToMessageId_chatId_fkey" FOREIGN KEY ("replyToMessageId", "chatId") REFERENCES "Message"("id", "chatId") ON DELETE RESTRICT ON UPDATE CASCADE;
