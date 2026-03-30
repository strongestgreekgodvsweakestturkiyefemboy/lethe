import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'lethe-dev-secret-change-in-production';

/** Tag name validation regex (same as admin tags). */
const TAG_NAME_RE = /^[\w\-.: ]{1,64}$/;

/** Extract and verify the Bearer JWT; returns the userId or null. */
function getUserId(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  try {
    const p = jwt.verify(h.slice(7), JWT_SECRET) as { sub: string };
    return p.sub;
  } catch {
    return null;
  }
}

/** Validate + normalise a tag name from the request body. Returns null on failure. */
function parseTagName(body: unknown, res: Response): string | null {
  const { name } = (body as Record<string, unknown> | null) ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' });
    return null;
  }
  const clean = name.trim().toLowerCase();
  if (!TAG_NAME_RE.test(clean)) {
    res.status(400).json({
      error: 'Tag name must be 1–64 characters: letters, digits, spaces, hyphens, underscores, dots, or colons',
    });
    return null;
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Post user-tags
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/posts/:postId/tags
 *
 * Add a user-defined tag to a post. Requires authentication.
 * Body: { name: string }
 */
export async function addUserPostTag(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  const { postId } = req.params;
  const name = parseTagName(req.body, res);
  if (!name) return;

  try {
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
    if (!post) { res.status(404).json({ error: 'Post not found' }); return; }

    const tag = await prisma.tag.upsert({
      where: { name },
      create: { name },
      update: {},
    });

    const entry = await prisma.userPostTag.upsert({
      where: { postId_tagId_userId: { postId, tagId: tag.id, userId } },
      create: { postId, tagId: tag.id, userId },
      update: {},
      select: { id: true, tag: { select: { id: true, name: true } }, createdAt: true },
    });

    logger.info('UserPostTag added', { postId, tagId: tag.id, userId });
    res.status(201).json({ tag: entry });
  } catch (err) {
    logger.error('addUserPostTag failed', { postId, name, error: (err as Error).message });
    next(err);
  }
}

/**
 * DELETE /api/v1/posts/:postId/tags/:tagId
 *
 * Remove the calling user's own user-tag from a post. Requires authentication.
 */
export async function removeUserPostTag(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  const { postId, tagId } = req.params;

  try {
    const deleted = await prisma.userPostTag.deleteMany({
      where: { postId, tagId, userId },
    });

    if (deleted.count === 0) {
      res.status(404).json({ error: 'Tag not found on this post for the current user' });
      return;
    }

    logger.info('UserPostTag removed', { postId, tagId, userId });
    res.json({ ok: true });
  } catch (err) {
    logger.error('removeUserPostTag failed', { postId, tagId, error: (err as Error).message });
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Creator user-tags
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/creators/:creatorId/tags
 *
 * Add a user-defined tag to a creator. Requires authentication.
 * Body: { name: string }
 */
export async function addUserCreatorTag(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  const { creatorId } = req.params;
  const name = parseTagName(req.body, res);
  if (!name) return;

  try {
    const creator = await prisma.creator.findUnique({ where: { id: creatorId }, select: { id: true } });
    if (!creator) { res.status(404).json({ error: 'Creator not found' }); return; }

    const tag = await prisma.tag.upsert({
      where: { name },
      create: { name },
      update: {},
    });

    const entry = await prisma.userCreatorTag.upsert({
      where: { creatorId_tagId_userId: { creatorId, tagId: tag.id, userId } },
      create: { creatorId, tagId: tag.id, userId },
      update: {},
      select: { id: true, tag: { select: { id: true, name: true } }, createdAt: true },
    });

    logger.info('UserCreatorTag added', { creatorId, tagId: tag.id, userId });
    res.status(201).json({ tag: entry });
  } catch (err) {
    logger.error('addUserCreatorTag failed', { creatorId, name, error: (err as Error).message });
    next(err);
  }
}

/**
 * DELETE /api/v1/creators/:creatorId/tags/:tagId
 *
 * Remove the calling user's own user-tag from a creator. Requires authentication.
 */
export async function removeUserCreatorTag(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  const { creatorId, tagId } = req.params;

  try {
    const deleted = await prisma.userCreatorTag.deleteMany({
      where: { creatorId, tagId, userId },
    });

    if (deleted.count === 0) {
      res.status(404).json({ error: 'Tag not found on this creator for the current user' });
      return;
    }

    logger.info('UserCreatorTag removed', { creatorId, tagId, userId });
    res.json({ ok: true });
  } catch (err) {
    logger.error('removeUserCreatorTag failed', { creatorId, tagId, error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/v1/creators/:creatorId/tags
 *
 * Returns importer tags (none currently, reserved for future) and aggregated
 * user-added tags for a creator. Optionally marks which ones the current
 * authenticated user added.
 */
export async function listCreatorTags(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getUserId(req);
  const { creatorId } = req.params;

  try {
    const creator = await prisma.creator.findUnique({ where: { id: creatorId }, select: { id: true } });
    if (!creator) { res.status(404).json({ error: 'Creator not found' }); return; }

    const rawUserTags = await prisma.userCreatorTag.findMany({
      where: { creatorId },
      select: { tagId: true, userId: true, tag: { select: { id: true, name: true } }, createdAt: true },
      orderBy: { tag: { name: 'asc' } },
    });

    // Deduplicate by tagId — aggregate across all users, mark own
    const tagsByTagId = new Map<string, { tag: { id: string; name: string }; addedByMe: boolean; createdAt: string }>();
    for (const ut of rawUserTags) {
      if (!tagsByTagId.has(ut.tagId)) {
        tagsByTagId.set(ut.tagId, {
          tag: ut.tag,
          addedByMe: ut.userId === userId,
          createdAt: ut.createdAt.toISOString(),
        });
      } else if (ut.userId === userId) {
        tagsByTagId.get(ut.tagId)!.addedByMe = true;
      }
    }

    res.json({ userTags: Array.from(tagsByTagId.values()) });
  } catch (err) {
    logger.error('listCreatorTags failed', { creatorId, error: (err as Error).message });
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Discord server user-tags
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/discord/servers/:serverId/tags
 *
 * Add a user-defined tag to a Discord server. Requires authentication.
 * Body: { name: string }
 */
export async function addUserDiscordServerTag(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  const { serverId } = req.params;
  const name = parseTagName(req.body, res);
  if (!name) return;

  try {
    const server = await prisma.discordServer.findUnique({ where: { id: serverId }, select: { id: true } });
    if (!server) { res.status(404).json({ error: 'Discord server not found' }); return; }

    const tag = await prisma.tag.upsert({
      where: { name },
      create: { name },
      update: {},
    });

    const entry = await prisma.userDiscordServerTag.upsert({
      where: { serverId_tagId_userId: { serverId, tagId: tag.id, userId } },
      create: { serverId, tagId: tag.id, userId },
      update: {},
      select: { id: true, tag: { select: { id: true, name: true } }, createdAt: true },
    });

    logger.info('UserDiscordServerTag added', { serverId, tagId: tag.id, userId });
    res.status(201).json({ tag: entry });
  } catch (err) {
    logger.error('addUserDiscordServerTag failed', { serverId, name, error: (err as Error).message });
    next(err);
  }
}

/**
 * DELETE /api/v1/discord/servers/:serverId/tags/:tagId
 *
 * Remove the calling user's own user-tag from a Discord server. Requires authentication.
 */
export async function removeUserDiscordServerTag(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  const { serverId, tagId } = req.params;

  try {
    const deleted = await prisma.userDiscordServerTag.deleteMany({
      where: { serverId, tagId, userId },
    });

    if (deleted.count === 0) {
      res.status(404).json({ error: 'Tag not found on this server for the current user' });
      return;
    }

    logger.info('UserDiscordServerTag removed', { serverId, tagId, userId });
    res.json({ ok: true });
  } catch (err) {
    logger.error('removeUserDiscordServerTag failed', { serverId, tagId, error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/v1/discord/servers/:serverId/tags
 *
 * Returns aggregated user-added tags for a Discord server. Optionally marks
 * which ones the current authenticated user added.
 */
export async function listDiscordServerTags(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = getUserId(req);
  const { serverId } = req.params;

  try {
    const server = await prisma.discordServer.findUnique({ where: { id: serverId }, select: { id: true } });
    if (!server) { res.status(404).json({ error: 'Discord server not found' }); return; }

    const rawUserTags = await prisma.userDiscordServerTag.findMany({
      where: { serverId },
      select: { tagId: true, userId: true, tag: { select: { id: true, name: true } }, createdAt: true },
      orderBy: { tag: { name: 'asc' } },
    });

    const tagsByTagId = new Map<string, { tag: { id: string; name: string }; addedByMe: boolean; createdAt: string }>();
    for (const ut of rawUserTags) {
      if (!tagsByTagId.has(ut.tagId)) {
        tagsByTagId.set(ut.tagId, {
          tag: ut.tag,
          addedByMe: ut.userId === userId,
          createdAt: ut.createdAt.toISOString(),
        });
      } else if (ut.userId === userId) {
        tagsByTagId.get(ut.tagId)!.addedByMe = true;
      }
    }

    res.json({ userTags: Array.from(tagsByTagId.values()) });
  } catch (err) {
    logger.error('listDiscordServerTags failed', { serverId, error: (err as Error).message });
    next(err);
  }
}
