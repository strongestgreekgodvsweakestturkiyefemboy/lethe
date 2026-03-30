-- AlterTable: add saveSession and savedToken columns to Job
ALTER TABLE "Job" ADD COLUMN "saveSession" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Job" ADD COLUMN "savedToken" TEXT;

-- CreateTable: SiteBranding singleton
CREATE TABLE "SiteBranding" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "siteName" TEXT NOT NULL DEFAULT 'Lethe',
    "siteTagline" TEXT NOT NULL DEFAULT 'Self-hosted data archival service',
    "accentColor" TEXT NOT NULL DEFAULT '#6366f1',
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteBranding_pkey" PRIMARY KEY ("id")
);
