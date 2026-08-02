-- Plan tiers, physical bag tracking, complaint photo evidence and complaint
-- remedy links.
--
-- Additive only: every new column is nullable or defaulted and the one new
-- table is fresh, so existing rows are untouched. Safe against live data.

-- AlterTable: bronze | silver | gold, drives the bag code letter (B/S/G)
ALTER TABLE "Plan" ADD COLUMN "tier" TEXT;

-- AlterTable: storage keys of photos attached to a complaint message
ALTER TABLE "ComplaintMessage" ADD COLUMN "photos" JSONB;

-- AlterTable: trace a complaint to the remedies granted for it
ALTER TABLE "Complaint" ADD COLUMN "redoOrderId" TEXT;
ALTER TABLE "Compensation" ADD COLUMN "complaintId" TEXT;

-- CreateTable: a physical bag issued to a student. First one complimentary,
-- replacements sold. Codes are never reused, so a lost bag is marked lost and
-- the student receives a new code.
CREATE TABLE "Bag" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "tier" TEXT,
    "complimentary" BOOLEAN NOT NULL DEFAULT false,
    "price" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedBy" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "Bag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: a code identifies exactly one physical bag
CREATE UNIQUE INDEX "Bag_code_key" ON "Bag"("code");
CREATE INDEX "Bag_studentId_status_idx" ON "Bag"("studentId", "status");

-- AddForeignKey
ALTER TABLE "Bag" ADD CONSTRAINT "Bag_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
