-- AlterTable: add discordAuthorId to Post
ALTER TABLE "Post" ADD COLUMN "discordAuthorId" TEXT;

-- AlterTable: add discordServerId to Creator
ALTER TABLE "Creator" ADD COLUMN "discordServerId" TEXT;

-- AlterTable: add discordServers relation to User (no column needed — FK lives on DiscordServer)

-- CreateTable: DiscordServer
CREATE TABLE "DiscordServer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "iconUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable: DiscordRole
CREATE TABLE "DiscordRole" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscordRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable: DiscordChannel
CREATE TABLE "DiscordChannel" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" INTEGER NOT NULL,
    "parentId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isVisible" BOOLEAN NOT NULL DEFAULT false,
    "creatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordChannel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscordServer_userId_guildId_key" ON "DiscordServer"("userId", "guildId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscordRole_serverId_roleId_key" ON "DiscordRole"("serverId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscordChannel_serverId_channelId_key" ON "DiscordChannel"("serverId", "channelId");

-- AddForeignKey: DiscordServer.userId -> User
ALTER TABLE "DiscordServer" ADD CONSTRAINT "DiscordServer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: DiscordRole.serverId -> DiscordServer
ALTER TABLE "DiscordRole" ADD CONSTRAINT "DiscordRole_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "DiscordServer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: DiscordChannel.serverId -> DiscordServer
ALTER TABLE "DiscordChannel" ADD CONSTRAINT "DiscordChannel_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "DiscordServer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: DiscordChannel.creatorId -> Creator
ALTER TABLE "DiscordChannel" ADD CONSTRAINT "DiscordChannel_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: Creator.discordServerId -> DiscordServer
ALTER TABLE "Creator" ADD CONSTRAINT "Creator_discordServerId_fkey" FOREIGN KEY ("discordServerId") REFERENCES "DiscordServer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
