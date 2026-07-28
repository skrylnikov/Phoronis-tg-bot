-- CreateTable
CREATE TABLE "DailyAnalytics" (
    "date" DATE NOT NULL,
    "reportSentAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyAnalytics_pkey" PRIMARY KEY ("date")
);
