-- Per-college pricing override (BVRIT etc.) and WhatsApp registration's college target.
-- All additive, nullable columns — no data loss, no existing row is affected.

ALTER TABLE "College" ADD COLUMN "rates" JSONB;
ALTER TABLE "College" ADD COLUMN "expressRates" JSONB;
ALTER TABLE "WaVerify" ADD COLUMN "collegeId" TEXT;
