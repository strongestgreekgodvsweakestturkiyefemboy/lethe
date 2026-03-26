-- Remove redundant title/content columns from Post.
-- Title and content are now stored exclusively in PostRevision.
-- Always read the PostRevision with the highest id for current title/content.
ALTER TABLE "Post" DROP COLUMN IF EXISTS "title";
ALTER TABLE "Post" DROP COLUMN IF EXISTS "content";

-- Remove redundant content column from Comment.
-- Content is now stored exclusively in CommentRevision.
-- Always read the CommentRevision with the highest id for current content.
ALTER TABLE "Comment" DROP COLUMN IF EXISTS "content";
