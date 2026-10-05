-- Complaint ownership and first-response deadline (both nullable: existing rows stay as they are)
ALTER TABLE "Complaint" ADD COLUMN "assignedStaffId" TEXT,
ADD COLUMN "respondBy" TIMESTAMP(3);

-- Daily cash count per campus
CREATE TABLE "DayCashCount" (
    "id" TEXT NOT NULL,
    "collegeId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "expectedCash" DECIMAL(10,2) NOT NULL,
    "countedCash" DECIMAL(10,2) NOT NULL,
    "diff" DECIMAL(10,2) NOT NULL,
    "staffId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DayCashCount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DayCashCount_collegeId_day_key" ON "DayCashCount"("collegeId", "day");
