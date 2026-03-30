import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'lethe-dev-secret-change-in-production';

/** Optionally extract userId from Bearer token without requiring it. */
function getUserIdOptional(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  try {
    const p = jwt.verify(h.slice(7), JWT_SECRET) as { sub: string };
    return p.sub;
  } catch {
    return null;
  }
}

/**
 * GET /api/v1/discord/servers
 *
 * Returns a list of all imported DiscordServer records (public, no auth required).
 */
export async function listDiscordServers(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  logger.debug('listDiscordServers called');

  try {
    const servers = await prisma.discordServer.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        guildId: true,
        name: true,
        iconUrl: true,
        createdAt: true,
        _count: { select: { channels: true } },
      },
    });

    res.json({ servers });
  } catch (err) {
    logger.error('listDiscordServers failed', { error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/v1/discord/servers/:serverId
 *
 * Returns a DiscordServer record with its channels (sorted by position) and
 * roles (sorted by position descending). If a Bearer token is provided the
 * response includes user-tags for the server with addedByMe flags.
 */
export async function getDiscordServer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { serverId } = req.params;
  const currentUserId = getUserIdOptional(req);
  logger.debug('getDiscordServer called', { serverId });

  try {
    const server = await prisma.discordServer.findUnique({
      where: { id: serverId },
      select: {
        id: true,
        guildId: true,
        name: true,
        iconUrl: true,
        createdAt: true,
        roles: {
          orderBy: { position: 'desc' },
          select: {
            id: true,
            roleId: true,
            name: true,
            color: true,
            position: true,
          },
        },
        channels: {
          orderBy: [{ position: 'asc' }, { name: 'asc' }],
          select: {
            id: true,
            channelId: true,
            name: true,
            type: true,
            parentId: true,
            position: true,
            isVisible: true,
            creatorId: true,
            _count: { select: { messages: true } },
          },
        },
        userTags: {
          select: { tagId: true, userId: true, tag: { select: { id: true, name: true } } },
          orderBy: { tag: { name: 'asc' } },
        },
      },
    });

    if (!server) {
      res.status(404).json({ error: 'Discord server not found' });
      return;
    }

    // Deduplicate and annotate user tags
    const seenTagIds = new Set<string>();
    const userTags: Array<{ tag: { id: string; name: string }; addedByMe: boolean }> = [];
    for (const ut of server.userTags) {
      if (!seenTagIds.has(ut.tagId)) {
        seenTagIds.add(ut.tagId);
        userTags.push({ tag: ut.tag, addedByMe: ut.userId === currentUserId });
      } else if (ut.userId === currentUserId) {
        const existing = userTags.find((u) => u.tag.id === ut.tagId);
        if (existing) existing.addedByMe = true;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userTags: _raw, ...serverData } = server;
    res.json({ server: { ...serverData, userTags } });
  } catch (err) {
    logger.error('getDiscordServer failed', { serverId, error: (err as Error).message });
    next(err);
  }
}
