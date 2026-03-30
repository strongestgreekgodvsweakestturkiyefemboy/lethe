-- Seed the 'default' placeholder user that is used as the owner of import jobs
-- when no userId is supplied.  Doing this at install time guarantees the row
-- exists before any real user registers, so the first-user admin check
-- (userCount <= 1) works correctly even when no imports have been run yet.
INSERT INTO "User" ("id", "isAdmin", "createdAt", "updatedAt")
VALUES ('default', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
