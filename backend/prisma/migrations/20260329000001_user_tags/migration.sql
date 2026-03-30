-- CreateTable: UserPostTag (user-added tags on posts)
CREATE TABLE "UserPostTag" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPostTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable: UserCreatorTag (user-added tags on creators)
CREATE TABLE "UserCreatorTag" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCreatorTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable: UserDiscordServerTag (user-added tags on Discord servers)
CREATE TABLE "UserDiscordServerTag" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDiscordServerTag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserPostTag_postId_tagId_userId_key" ON "UserPostTag"("postId", "tagId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserCreatorTag_creatorId_tagId_userId_key" ON "UserCreatorTag"("creatorId", "tagId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserDiscordServerTag_serverId_tagId_userId_key" ON "UserDiscordServerTag"("serverId", "tagId", "userId");

-- AddForeignKey
ALTER TABLE "UserPostTag" ADD CONSTRAINT "UserPostTag_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPostTag" ADD CONSTRAINT "UserPostTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPostTag" ADD CONSTRAINT "UserPostTag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCreatorTag" ADD CONSTRAINT "UserCreatorTag_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCreatorTag" ADD CONSTRAINT "UserCreatorTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCreatorTag" ADD CONSTRAINT "UserCreatorTag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDiscordServerTag" ADD CONSTRAINT "UserDiscordServerTag_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "DiscordServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDiscordServerTag" ADD CONSTRAINT "UserDiscordServerTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDiscordServerTag" ADD CONSTRAINT "UserDiscordServerTag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
