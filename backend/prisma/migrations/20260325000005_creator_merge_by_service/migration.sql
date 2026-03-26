-- Migration: replace the 4-column Creator unique key with a 3-column one.
--
-- Previously creators were keyed by (userId, sourceSite, serviceType, externalId),
-- which meant the same Patreon creator imported via Kemono ("sourceSite=kemono")
-- and directly from Patreon ("sourceSite=patreon") would produce *two separate*
-- Creator rows and their posts would never be merged.
--
-- The new key is (userId, serviceType, externalId) so that any importer that
-- produces the same serviceType + externalId pair for a given user will always
-- resolve to the same Creator row, regardless of which sourceSite imported it.
--
-- Before dropping the old index we deduplicate any existing rows that would
-- violate the new constraint: for each duplicate group we keep the row with the
-- most recently-updated timestamp and re-parent all Post rows to it, then
-- delete the duplicates.

DO $$
DECLARE
    dup RECORD;
    keep_id TEXT;
BEGIN
    -- Find groups that have more than one Creator row for the same
    -- (userId, serviceType, externalId) tuple.
    FOR dup IN
        SELECT "userId", "serviceType", "externalId"
        FROM   "Creator"
        GROUP  BY "userId", "serviceType", "externalId"
        HAVING COUNT(*) > 1
    LOOP
        -- Pick the winner: the row updated most recently (highest updatedAt).
        SELECT id INTO keep_id
        FROM   "Creator"
        WHERE  "userId"      = dup."userId"
          AND  "serviceType" = dup."serviceType"
          AND  "externalId"  = dup."externalId"
        ORDER  BY "updatedAt" DESC
        LIMIT  1;

        -- Re-parent posts belonging to any of the duplicate rows.
        UPDATE "Post" p
        SET    "creatorId" = keep_id
        WHERE  p."creatorId" IN (
            SELECT id
            FROM   "Creator"
            WHERE  "userId"      = dup."userId"
              AND  "serviceType" = dup."serviceType"
              AND  "externalId"  = dup."externalId"
              AND  id           <> keep_id
        )
        -- Avoid violating the Post (creatorId, externalId) unique constraint
        -- by skipping posts whose externalId already exists on the winner row.
        AND NOT EXISTS (
            SELECT 1 FROM "Post" winner
            WHERE  winner."creatorId"  = keep_id
              AND  winner."externalId" = p."externalId"
        );

        -- Delete the now-orphaned duplicate Creator rows (any remaining posts
        -- referencing them were already covered by the winner row and can be
        -- dropped to avoid orphan FK violations).
        DELETE FROM "Post"
        WHERE "creatorId" IN (
            SELECT id FROM "Creator"
            WHERE  "userId"      = dup."userId"
              AND  "serviceType" = dup."serviceType"
              AND  "externalId"  = dup."externalId"
              AND  id           <> keep_id
        );

        DELETE FROM "Creator"
        WHERE  "userId"      = dup."userId"
          AND  "serviceType" = dup."serviceType"
          AND  "externalId"  = dup."externalId"
          AND  id           <> keep_id;
    END LOOP;
END $$;

-- DropIndex: old 4-column unique constraint.
DROP INDEX "Creator_userId_sourceSite_serviceType_externalId_key";

-- CreateIndex: new 3-column unique constraint (sourceSite excluded).
CREATE UNIQUE INDEX "Creator_userId_serviceType_externalId_key"
    ON "Creator"("userId", "serviceType", "externalId");
