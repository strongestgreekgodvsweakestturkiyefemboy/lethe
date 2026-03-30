import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'lethe-dev-secret-change-in-production';

/** Extract verified userId from Bearer token, or return null. */
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

// ---------------------------------------------------------------------------
// Latest users
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/users?limit=&cursor=
 *
 * Returns the most recently created users (those with a username set).
 */
export async function listLatestUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10), 100);
  const cursor = req.query.cursor as string | undefined;

  try {
    const users = await prisma.user.findMany({
      where: { username: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, username: true, createdAt: true },
    });

    const hasMore = users.length > limit;
    const page = hasMore ? users.slice(0, limit) : users;
    res.json({ users: page, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// User preferences
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/users/preferences   (requires auth)
 */
export async function getPreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    const prefs = await prisma.userPreferences.findUnique({ where: { userId } });
    res.json({ preferences: prefs ?? null });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/v1/users/preferences   (requires auth)
 *
 * Body: { fontSize?, fontFamily?, bgColor?, fontColor?, accentColor?, contentBgColor?, contentTextColor?, contentFontFamily?, contentFontSize? }
 */
export async function updatePreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { fontSize, fontFamily, bgColor, fontColor, accentColor, contentBgColor, contentTextColor, contentFontFamily, contentFontSize } = req.body as {
    fontSize?: number;
    fontFamily?: string;
    bgColor?: string;
    fontColor?: string;
    accentColor?: string;
    contentBgColor?: string;
    contentTextColor?: string;
    contentFontFamily?: string;
    contentFontSize?: number;
  };

  try {
    const prefs = await prisma.userPreferences.upsert({
      where: { userId },
      update: {
        ...(fontSize != null ? { fontSize } : {}),
        ...(fontFamily ? { fontFamily } : {}),
        ...(bgColor ? { bgColor } : {}),
        ...(fontColor ? { fontColor } : {}),
        ...(accentColor ? { accentColor } : {}),
        ...(contentBgColor ? { contentBgColor } : {}),
        ...(contentTextColor ? { contentTextColor } : {}),
        ...(contentFontFamily ? { contentFontFamily } : {}),
        ...(contentFontSize != null ? { contentFontSize } : {}),
      },
      create: {
        userId,
        fontSize: fontSize ?? 14,
        fontFamily: fontFamily ?? 'sans-serif',
        bgColor: bgColor ?? '#030712',
        fontColor: fontColor ?? '#ffffff',
        accentColor: accentColor ?? '#111827',
        contentBgColor: contentBgColor ?? '#1f2937',
        contentTextColor: contentTextColor ?? '#e5e7eb',
        contentFontFamily: contentFontFamily ?? 'sans-serif',
        contentFontSize: contentFontSize ?? 14,
      },
    });
    res.json({ preferences: prefs });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/favorites   (requires auth)
 */
export async function listFavorites(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    const favs = await prisma.userFavorite.findMany({
      where: { userId },
      include: {
        creator: {
          select: { id: true, name: true, serviceType: true, externalId: true, thumbnailUrl: true, sourceSite: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ favorites: favs.map((f) => f.creator) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/favorites   (requires auth)
 *
 * Body: { creatorId }
 */
export async function addFavorite(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { creatorId } = req.body as { creatorId?: string };
  if (!creatorId) { res.status(400).json({ error: 'creatorId is required' }); return; }

  try {
    await prisma.userFavorite.upsert({
      where: { userId_creatorId: { userId, creatorId } },
      update: {},
      create: { userId, creatorId },
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/favorites/:creatorId   (requires auth)
 */
export async function removeFavorite(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { creatorId } = req.params;

  try {
    await prisma.userFavorite.deleteMany({ where: { userId, creatorId } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Feed (posts from favorited creators)
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/feed?limit=&cursor=   (requires auth)
 */
export async function getFeed(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10), 100);
  const cursor = req.query.cursor as string | undefined;

  try {
    const favs = await prisma.userFavorite.findMany({
      where: { userId },
      select: { creatorId: true },
    });
    const creatorIds = favs.map((f) => f.creatorId);

    if (creatorIds.length === 0) {
      res.json({ posts: [], nextCursor: null });
      return;
    }

    const posts = await prisma.post.findMany({
      where: { creatorId: { in: creatorIds } },
      orderBy: { publishedAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        creator: { select: { id: true, name: true, serviceType: true, externalId: true, thumbnailUrl: true } },
        revisions: { orderBy: { id: 'desc' }, take: 1, select: { title: true, content: true } },
        attachments: { select: { id: true, dataType: true, fileUrl: true, name: true } },
        _count: { select: { comments: true } },
      },
    });

    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;
    res.json({ posts: page, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Latest posts (public)
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/posts/latest?limit=&cursor=
 */
export async function listLatestPosts(req: Request, res: Response, next: NextFunction): Promise<void> {
  const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10), 100);
  const cursor = req.query.cursor as string | undefined;

  try {
    const posts = await prisma.post.findMany({
      where: { creator: { NOT: { serviceType: 'discord' } } },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        creator: { select: { id: true, name: true, serviceType: true, externalId: true, thumbnailUrl: true } },
        revisions: { orderBy: { id: 'desc' }, take: 1, select: { title: true, content: true } },
        _count: { select: { attachments: true, comments: true } },
      },
    });

    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;
    res.json({ posts: page, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/search/posts?q=&limit=&cursor=
 */
export async function searchPosts(req: Request, res: Response, next: NextFunction): Promise<void> {
  const q = (req.query.q as string | undefined)?.trim();
  if (!q) { res.status(400).json({ error: 'q query parameter is required' }); return; }

  const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10), 100);
  const cursor = req.query.cursor as string | undefined;

  try {
    const posts = await prisma.post.findMany({
      where: {
        revisions: {
          some: {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { content: { contains: q, mode: 'insensitive' } },
            ],
          },
        },
      },
      orderBy: { publishedAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        creator: { select: { id: true, name: true, serviceType: true, externalId: true } },
        revisions: { orderBy: { id: 'desc' }, take: 1, select: { title: true, content: true } },
        _count: { select: { attachments: true, comments: true } },
      },
    });

    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;
    res.json({ posts: page, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/search/users?q=&limit=&cursor=
 */
export async function searchUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  const q = (req.query.q as string | undefined)?.trim();
  if (!q) { res.status(400).json({ error: 'q query parameter is required' }); return; }

  const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10), 100);
  const cursor = req.query.cursor as string | undefined;

  try {
    const users = await prisma.user.findMany({
      where: {
        username: { contains: q, mode: 'insensitive', not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, username: true, createdAt: true },
    });

    const hasMore = users.length > limit;
    const page = hasMore ? users.slice(0, limit) : users;
    res.json({ users: page, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (err) {
    next(err);
  }
}
