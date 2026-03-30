-- CreateTable: ImporterSetting — admin-configurable enable/disable per importer.
-- If no row exists for an importer key the importer defaults to enabled.
CREATE TABLE "ImporterSetting" (
    "id"        TEXT        NOT NULL,
    "enabled"   BOOLEAN     NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImporterSetting_pkey" PRIMARY KEY ("id")
);
