-- Plan tiers + complimentary-bag codes + complaint photo evidence.
-- Additive only: every new column is nullable or defaulted, so existing rows
-- are untouched and this is safe to run against live data.

-- AlterTable: bronze | silver | gold, drives the bag code letter (B/S/G)
ALTER TABLE "Plan" ADD COLUMN "tier" TEXT;

-- AlterTable: the code printed on the student's complimentary bag, plus handover tracking
ALTER TABLE "Subscription" ADD COLUMN "planCode" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "bagGiven" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Subscription" ADD COLUMN "bagGivenAt" TIMESTAMP(3);

-- AlterTable: storage keys of photos attached to a complaint message
ALTER TABLE "ComplaintMessage" ADD COLUMN "photos" JSONB;

-- CreateIndex: a bag code identifies one physical bag, so it must never repeat
CREATE UNIQUE INDEX "Subscription_planCode_key" ON "Subscription"("planCode");
