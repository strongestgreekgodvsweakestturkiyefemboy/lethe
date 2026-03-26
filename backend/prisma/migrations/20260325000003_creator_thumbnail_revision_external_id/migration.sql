-- Add thumbnailUrl to Creator
ALTER TABLE "Creator" ADD COLUMN IF NOT EXISTS "thumbnailUrl" TEXT;

-- Add revisionExternalId to PostRevision for historical revision tracking.
-- NULL = current/live revision written during a normal import.
-- Non-NULL = a historical snapshot imported from the source platform.
ALTER TABLE "PostRevision" ADD COLUMN IF NOT EXISTS "revisionExternalId" TEXT;

-- Unique constraint: each historical revision ID (non-NULL) can only appear once
-- per post.  PostgreSQL treats NULL as distinct so multiple current revisions
-- (revisionExternalId IS NULL) are still allowed.
CREATE UNIQUE INDEX IF NOT EXISTS "PostRevision_postId_revisionExternalId_key"
  ON "PostRevision"("postId", "revisionExternalId");
