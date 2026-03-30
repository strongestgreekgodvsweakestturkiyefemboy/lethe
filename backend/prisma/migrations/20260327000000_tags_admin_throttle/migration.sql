-- Add isAdmin flag to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Add creatorExternalId to Job (for 90-min throttle)
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "creatorExternalId" TEXT;

-- Create Tag table
CREATE TABLE IF NOT EXISTS "Tag" (
  "id"        TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Tag_name_key" ON "Tag"("name");

-- Create PostTag join table
CREATE TABLE IF NOT EXISTS "PostTag" (
  "id"        TEXT NOT NULL,
  "postId"    TEXT NOT NULL,
  "tagId"     TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PostTag_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "PostTag" ADD CONSTRAINT "PostTag_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostTag" ADD CONSTRAINT "PostTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "PostTag_postId_tagId_key" ON "PostTag"("postId", "tagId");
