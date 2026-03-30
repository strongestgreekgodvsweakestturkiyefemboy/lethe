import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';

const prisma = new PrismaClient();

const PAGE_SIZE = 50;

/**
 * Public API — no authentication required.
 *
 * These endpoints expose the content stored in Lethe to anyone who can reach
 * the backend, mirroring the read-only data that Kemono.cr makes available on
 * its own public API.  Write operations are never exposed here.
 */

// ---------------------------------------------------------------------------
// GET /api/v1/creators.json
//
// Returns a paginated list of all creators in the system.
//
// Query params:
//   service — optional filter by serviceType (e.g. "patreon", "fanbox")
//   q       — optional substring search against creator name
//   cursor  — keyset pagination cursor (id of last creator from previous page)
//   limit   — page size (max 100, default 50)
// ---------------------------------------------------------------------------
export async function listPublicCreators(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { service, q, cursor } = req.query as Record<string, string | undefined>;
  const limit = Math.min(
    parseInt((req.query.limit as string) ?? String(PAGE_SIZE), 10),
    100,
  );
  logger.debug('listPublicCreators called', { service, q, cursor, limit });

  try {
    const creators = await prisma.creator.findMany({
      where: {
        NOT: { serviceType: 'discord' },
        ...(service ? { serviceType: service } : {}),
        ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        sourceSite: true,
        serviceType: true,
        externalId: true,
        name: true,
        thumbnailUrl: true,
        bannerUrl: true,
        updatedAt: true,
        createdAt: true,
        _count: { select: { posts: true } },
      },
    });

    const hasMore = creators.length > limit;
    const page = hasMore ? creators.slice(0, limit) : creators;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    logger.debug('listPublicCreators returning page', { count: page.length, hasMore });
    res.json({ creators: page, nextCursor });
  } catch (err) {
    logger.error('listPublicCreators failed', { error: (err as Error).message });
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/:service/user/:creatorExternalId
// (already exists in itemsController — kept there for backward compat)
//
// GET /api/v1/creators/:service/:creatorExternalId
//
// Returns a creator and the first page of their posts (public, no auth).
//
// Path params:
//   service           — serviceType (e.g. "patreon")
//   creatorExternalId — creator's ID on the source platform
//
// Query params:
//   cursor — keyset pagination cursor
//   limit  — page size (max 100, default 50)
// ---------------------------------------------------------------------------
export async function getPublicCreator(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { service, creatorExternalId } = req.params;
  const { cursor } = req.query as Record<string, string | undefined>;
  const limit = Math.min(
    parseInt((req.query.limit as string) ?? String(PAGE_SIZE), 10),
    100,
  );
  logger.debug('getPublicCreator called', { service, creatorExternalId, cursor, limit });

  try {
    const creator = await prisma.creator.findFirst({
      where: { serviceType: service, externalId: creatorExternalId },
      select: {
        id: true,
        sourceSite: true,
        serviceType: true,
        externalId: true,
        name: true,
        thumbnailUrl: true,
        bannerUrl: true,
        updatedAt: true,
        createdAt: true,
        _count: { select: { posts: true } },
      },
    });

    if (!creator) {
      logger.warn('getPublicCreator: creator not found', { service, creatorExternalId });
      res.status(404).json({ error: 'Creator not found' });
      return;
    }

    const posts = await prisma.post.findMany({
      where: { creatorId: creator.id },
      orderBy: { publishedAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        externalId: true,
        publishedAt: true,
        updatedAt: true,
        createdAt: true,
        revisions: {
          where: { revisionExternalId: null },
          orderBy: { id: 'desc' },
          take: 1,
          select: { title: true, content: true },
        },
        attachments: {
          select: { id: true, fileUrl: true, dataType: true, name: true },
          orderBy: { createdAt: 'asc' },
        },
        tags: {
          select: { tag: { select: { id: true, name: true } } },
          orderBy: { tag: { name: 'asc' } },
        },
        _count: { select: { attachments: true, comments: true } },
      },
    });

    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    logger.debug('getPublicCreator returning page', {
      service,
      creatorExternalId,
      postCount: page.length,
    });
    res.json({ creator, posts: page, nextCursor });
  } catch (err) {
    logger.error('getPublicCreator failed', {
      service,
      creatorExternalId,
      error: (err as Error).message,
    });
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/creators/:service/:creatorExternalId/posts
//
// Returns a paginated list of posts for a specific creator.
//
// Query params:
//   cursor — keyset pagination cursor
//   limit  — page size (max 100, default 50)
// ---------------------------------------------------------------------------
export async function listPublicPosts(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { service, creatorExternalId } = req.params;
  const { cursor } = req.query as Record<string, string | undefined>;
  const limit = Math.min(
    parseInt((req.query.limit as string) ?? String(PAGE_SIZE), 10),
    100,
  );
  logger.debug('listPublicPosts called', { service, creatorExternalId, cursor, limit });

  try {
    const creator = await prisma.creator.findFirst({
      where: { serviceType: service, externalId: creatorExternalId },
      select: { id: true },
    });

    if (!creator) {
      logger.warn('listPublicPosts: creator not found', { service, creatorExternalId });
      res.status(404).json({ error: 'Creator not found' });
      return;
    }

    const posts = await prisma.post.findMany({
      where: { creatorId: creator.id },
      orderBy: { publishedAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        externalId: true,
        publishedAt: true,
        updatedAt: true,
        createdAt: true,
        revisions: {
          where: { revisionExternalId: null },
          orderBy: { id: 'desc' },
          take: 1,
          select: { title: true, content: true },
        },
        attachments: {
          select: { id: true, fileUrl: true, dataType: true, name: true },
          orderBy: { createdAt: 'asc' },
        },
        comments: {
          select: {
            id: true,
            externalId: true,
            authorName: true,
            publishedAt: true,
            revisions: {
              select: { content: true },
              orderBy: { id: 'desc' },
              take: 1,
            },
          },
          orderBy: [{ publishedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        },
        tags: {
          select: { tag: { select: { id: true, name: true } } },
          orderBy: { tag: { name: 'asc' } },
        },
        _count: { select: { attachments: true, comments: true } },
      },
    });

    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    logger.debug('listPublicPosts returning page', {
      service,
      creatorExternalId,
      count: page.length,
    });
    res.json({ posts: page, nextCursor });
  } catch (err) {
    logger.error('listPublicPosts failed', {
      service,
      creatorExternalId,
      error: (err as Error).message,
    });
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/creators/:service/:creatorExternalId/post/:postExternalId
//
// Returns the full detail of a single post (attachments, comments, revisions).
//
// Path params:
//   service           — serviceType
//   creatorExternalId — creator's ID on the source platform
//   postExternalId    — post's ID on the source platform
// ---------------------------------------------------------------------------
export async function getPublicPost(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { service, creatorExternalId, postExternalId } = req.params;
  logger.debug('getPublicPost called', { service, creatorExternalId, postExternalId });

  try {
    const creator = await prisma.creator.findFirst({
      where: { serviceType: service, externalId: creatorExternalId },
      select: { id: true },
    });

    if (!creator) {
      logger.warn('getPublicPost: creator not found', { service, creatorExternalId });
      res.status(404).json({ error: 'Creator not found' });
      return;
    }

    const post = await prisma.post.findUnique({
      where: {
        creatorId_externalId: { creatorId: creator.id, externalId: postExternalId },
      },
      include: {
        attachments: {
          select: { id: true, fileUrl: true, dataType: true, name: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
        comments: {
          select: {
            id: true,
            externalId: true,
            authorName: true,
            publishedAt: true,
            createdAt: true,
            revisions: {
              select: { id: true, content: true, createdAt: true },
              orderBy: { id: 'desc' },
            },
          },
          orderBy: [{ publishedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        },
        revisions: {
          select: {
            id: true,
            title: true,
            content: true,
            createdAt: true,
            revisionExternalId: true,
          },
          orderBy: { id: 'desc' },
        },
        tags: {
          select: { tag: { select: { id: true, name: true } } },
          orderBy: { tag: { name: 'asc' } },
        },
        creator: {
          select: {
            id: true,
            sourceSite: true,
            serviceType: true,
            externalId: true,
            name: true,
            thumbnailUrl: true,
            bannerUrl: true,
          },
        },
      },
    });

    if (!post) {
      logger.warn('getPublicPost: post not found', { service, creatorExternalId, postExternalId });
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    logger.debug('getPublicPost returning post', { service, creatorExternalId, postExternalId });
    res.json({ post });
  } catch (err) {
    logger.error('getPublicPost failed', {
      service,
      creatorExternalId,
      postExternalId,
      error: (err as Error).message,
    });
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/posts/latest.json
//
// Returns the most recently published posts across all creators.
//
// Query params:
//   service — optional filter by serviceType
//   cursor  — keyset pagination cursor
//   limit   — page size (max 100, default 50)
// ---------------------------------------------------------------------------
export async function listPublicLatestPosts(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { service, cursor } = req.query as Record<string, string | undefined>;
  const limit = Math.min(
    parseInt((req.query.limit as string) ?? String(PAGE_SIZE), 10),
    100,
  );
  logger.debug('listPublicLatestPosts called', { service, cursor, limit });

  try {
    const posts = await prisma.post.findMany({
      where: {
        creator: {
          NOT: { serviceType: 'discord' },
          ...(service ? { serviceType: service } : {}),
        },
      },
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        externalId: true,
        publishedAt: true,
        updatedAt: true,
        createdAt: true,
        revisions: {
          where: { revisionExternalId: null },
          orderBy: { id: 'desc' },
          take: 1,
          select: { title: true, content: true },
        },
        attachments: {
          select: { id: true, fileUrl: true, dataType: true, name: true },
          orderBy: { createdAt: 'asc' },
        },
        tags: {
          select: { tag: { select: { id: true, name: true } } },
          orderBy: { tag: { name: 'asc' } },
        },
        creator: {
          select: {
            id: true,
            sourceSite: true,
            serviceType: true,
            externalId: true,
            name: true,
            thumbnailUrl: true,
          },
        },
        _count: { select: { attachments: true, comments: true } },
      },
    });

    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    logger.debug('listPublicLatestPosts returning page', { count: page.length, hasMore });
    res.json({ posts: page, nextCursor });
  } catch (err) {
    logger.error('listPublicLatestPosts failed', { error: (err as Error).message });
    next(err);
  }
}
