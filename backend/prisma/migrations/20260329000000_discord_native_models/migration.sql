-- Add native Discord message/user models for proper Discord-specific data storage.
-- Existing DiscordServer / DiscordRole / DiscordChannel tables are kept intact;
-- DiscordChannel gains two new relations (messages + threads).

-- DiscordUser: one row per Discord user snowflake, shared across guilds.
CREATE TABLE "DiscordUser" (
    "id"         TEXT NOT NULL,
    "discordId"  TEXT NOT NULL,
    "username"   TEXT,
    "globalName" TEXT,
    "avatarUrl"  TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiscordUser_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DiscordUser_discordId_key" ON "DiscordUser"("discordId");

-- DiscordGuildMember: junction between DiscordUser and DiscordServer (guild).
CREATE TABLE "DiscordGuildMember" (
    "id"        TEXT NOT NULL,
    "guildId"   TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "nickname"  TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiscordGuildMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DiscordGuildMember_guildId_userId_key" ON "DiscordGuildMember"("guildId", "userId");
ALTER TABLE "DiscordGuildMember"
    ADD CONSTRAINT "DiscordGuildMember_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "DiscordServer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DiscordGuildMember"
    ADD CONSTRAINT "DiscordGuildMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "DiscordUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DiscordThread: thread (forum post / reply thread) within a channel.
CREATE TABLE "DiscordThread" (
    "id"        TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "threadId"  TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "ownerId"   TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiscordThread_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DiscordThread_channelId_threadId_key" ON "DiscordThread"("channelId", "threadId");
ALTER TABLE "DiscordThread"
    ADD CONSTRAINT "DiscordThread_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "DiscordChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DiscordMessage: a single message in a channel or thread.
CREATE TABLE "DiscordMessage" (
    "id"          TEXT NOT NULL,
    "messageId"   TEXT NOT NULL,
    "channelId"   TEXT NOT NULL,
    "threadId"    TEXT,
    "authorId"    TEXT,
    "content"     TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DiscordMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DiscordMessage_channelId_messageId_key" ON "DiscordMessage"("channelId", "messageId");
ALTER TABLE "DiscordMessage"
    ADD CONSTRAINT "DiscordMessage_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "DiscordChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DiscordMessage"
    ADD CONSTRAINT "DiscordMessage_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "DiscordThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DiscordMessage"
    ADD CONSTRAINT "DiscordMessage_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "DiscordUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DiscordMessageRevision: edit history for a DiscordMessage.
CREATE TABLE "DiscordMessageRevision" (
    "id"        TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "content"   TEXT,
    "editedAt"  TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscordMessageRevision_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "DiscordMessageRevision"
    ADD CONSTRAINT "DiscordMessageRevision_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "DiscordMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DiscordAttachment: file attached to a DiscordMessage and stored in S3.
CREATE TABLE "DiscordAttachment" (
    "id"          TEXT NOT NULL,
    "messageId"   TEXT NOT NULL,
    "fileUrl"     TEXT NOT NULL,
    "dataType"    "DataType" NOT NULL,
    "name"        TEXT,
    "originalUrl" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscordAttachment_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "DiscordAttachment"
    ADD CONSTRAINT "DiscordAttachment_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "DiscordMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
