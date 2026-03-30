import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';

const prisma = new PrismaClient();

/**
 * GET /api/v1/discord/servers/:serverId/channels/:channelId/messages
 *
 * Returns paginated DiscordMessages for a given channel, newest first.
 * Supports cursor-based pagination via `?before=<messageId>` and `?limit=<n>`.
 */
export async function listChannelMessages(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { serverId, channelId } = req.params;
  const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10), 100);
  const before = req.query.before as string | undefined;

  logger.debug('listChannelMessages called', { serverId, channelId, limit, before });

  try {
    // Resolve the DiscordChannel record
    const channel = await prisma.discordChannel.findFirst({
      where: { serverId, channelId },
      select: { id: true, name: true, channelId: true },
    });

    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    const messages = await prisma.discordMessage.findMany({
      where: {
        channelId: channel.id,
        ...(before
          ? {
              publishedAt: {
                lt: (
                  await prisma.discordMessage.findFirst({
                    where: { channelId: channel.id, messageId: before },
                    select: { publishedAt: true },
                  })
                )?.publishedAt ?? undefined,
              },
            }
          : {}),
      },
      orderBy: { publishedAt: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        messageId: true,
        content: true,
        publishedAt: true,
        createdAt: true,
        author: {
          select: {
            id: true,
            discordId: true,
            username: true,
            globalName: true,
            avatarUrl: true,
          },
        },
        attachments: {
          select: {
            id: true,
            fileUrl: true,
            dataType: true,
            name: true,
            originalUrl: true,
          },
        },
        revisions: {
          orderBy: { id: 'desc' },
          take: 1,
          select: { content: true, editedAt: true },
        },
        _count: { select: { attachments: true, revisions: true } },
      },
    });

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;
    const nextCursor = hasMore ? page[page.length - 1]?.messageId ?? null : null;

    res.json({ messages: page, nextCursor, channelId: channel.channelId, channelName: channel.name });
  } catch (err) {
    logger.error('listChannelMessages failed', { serverId, channelId, error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/v1/discord/users/:discordUserId/messages
 *
 * Returns paginated DiscordMessages authored by a given Discord user (snowflake),
 * across all channels the calling user has access to.
 * Supports cursor-based pagination via `?cursor=<messageDbId>` and `?limit=<n>`.
 */
export async function listUserMessages(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { discordUserId } = req.params;
  const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10), 100);
  const cursor = req.query.cursor as string | undefined;

  logger.debug('listUserMessages called', { discordUserId, limit, cursor });

  try {
    const discordUser = await prisma.discordUser.findUnique({
      where: { discordId: discordUserId },
      select: { id: true, discordId: true, username: true, globalName: true, avatarUrl: true },
    });

    if (!discordUser) {
      res.status(404).json({ error: 'Discord user not found' });
      return;
    }

    const messages = await prisma.discordMessage.findMany({
      where: {
        authorId: discordUser.id,
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { publishedAt: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        messageId: true,
        content: true,
        publishedAt: true,
        createdAt: true,
        channel: {
          select: {
            id: true,
            channelId: true,
            name: true,
            server: { select: { id: true, guildId: true, name: true } },
          },
        },
        attachments: {
          select: {
            id: true,
            fileUrl: true,
            dataType: true,
            name: true,
          },
        },
        revisions: {
          orderBy: { id: 'desc' },
          take: 1,
          select: { content: true, editedAt: true },
        },
      },
    });

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;
    const nextCursor = hasMore ? page[page.length - 1]?.id ?? null : null;

    res.json({ messages: page, nextCursor, user: discordUser });
  } catch (err) {
    logger.error('listUserMessages failed', { discordUserId, error: (err as Error).message });
    next(err);
  }
}
