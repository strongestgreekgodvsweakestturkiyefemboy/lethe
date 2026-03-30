-- AlterTable: Add new preference columns to UserPreferences
ALTER TABLE "UserPreferences" ADD COLUMN "accentColor" TEXT NOT NULL DEFAULT '#111827';
ALTER TABLE "UserPreferences" ADD COLUMN "contentBgColor" TEXT NOT NULL DEFAULT '#1f2937';
ALTER TABLE "UserPreferences" ADD COLUMN "contentTextColor" TEXT NOT NULL DEFAULT '#e5e7eb';
ALTER TABLE "UserPreferences" ADD COLUMN "contentFontFamily" TEXT NOT NULL DEFAULT 'sans-serif';
ALTER TABLE "UserPreferences" ADD COLUMN "contentFontSize" INTEGER NOT NULL DEFAULT 14;
