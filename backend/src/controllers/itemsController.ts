import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'lethe-dev-secret-change-in-production';

const s3 = new S3Client({
  endpoint: process.env.AWS_ENDPOINT_URL,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  },
  forcePathStyle: true,
});

const BUCKET = process.env.AWS_BUCKET_NAME ?? 'lethe-imports';
const PAGE_SIZE = 50;

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
 * GET /api/v1/items
 *
 * Returns a paginated list of DataItems for the given userId.
 *
 * Query params:
 *   userId     — required — filter by owning user
 *   sourceSite — optional filter (e.g. "kemono", "site_a")
 *   dataType   — optional filter (TEXT | IMAGE | VIDEO | AUDIO)
 *   cursor     — id of the last item from the previous page
 *   limit      — page size (max 100, default 50)
 */
export async function listItems(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { userId, sourceSite, dataType, cursor } = req.query as Record<string, string | undefined>;
  logger.debug('listItems called', { userId, sourceSite, dataType, cursor });

  const limit = Math.min(parseInt((req.query.limit as string) ?? String(PAGE_SIZE), 10), 100);

  try {
    const items = await prisma.dataItem.findMany({
      where: {
        ...(userId ? { userId } : {}),
        ...(sourceSite ? { sourceSite } : {}),
        ...(dataType ? { dataType: dataType as 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE' } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        userId: true,
        sourceSite: true,
        dataType: true,
        content: true,
        fileUrl: true,
        sourcePostId: true,
        publishedAt: true,
        createdAt: true,
      },
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    logger.debug('listItems returning page', { userId, count: page.length, hasMore, nextCursor });
    res.json({ items: page, nextCursor });
  } catch (err) {
    logger.error('listItems failed', { userId, error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/v1/files/presign?key=<s3-object-key>
 *
 * Returns a short-lived presigned URL for the given S3 object key.
 * The URL expires in 15 minutes.
 */
export async function presignFile(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.query.key as string | undefined;
  logger.debug('presignFile called', { key });

  if (!key) {
    logger.warn('presignFile: missing key parameter');
    res.status(400).json({ error: 'key query parameter is required' });
    return;
  }

  try {
    logger.debug('Generating presigned URL', { bucket: BUCKET, key });
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const url = await getSignedUrl(s3, command, { expiresIn: 900 });
    logger.debug('Presigned URL generated', { key, expiresIn: 900 });

    res.json({ url });
  } catch (err) {
    logger.error('presignFile failed', { key, error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/v1/creators
 *
 * Returns a paginated list of Creators for the given userId.
 *
 * Query params:
 *   userId      — required
 *   sourceSite  — optional filter (e.g. "kemono")
 *   serviceType — optional filter (e.g. "patreon", "fanbox")
 *   cursor      — id of the last creator from the previous page
 *   limit       — page size (max 100, default 50)
 */
export async function listCreators(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { userId, sourceSite, serviceType, cursor } = req.query as Record<
    string,
    string | undefined
  >;
  logger.debug('listCreators called', { userId, sourceSite, serviceType, cursor });

  const limit = Math.min(parseInt((req.query.limit as string) ?? String(PAGE_SIZE), 10), 100);

  try {
    const creators = await prisma.creator.findMany({
      where: {
        NOT: { serviceType: 'discord' },
        ...(userId ? { userId } : {}),
        ...(sourceSite ? { sourceSite } : {}),
        ...(serviceType ? { serviceType } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        userId: true,
        sourceSite: true,
        serviceType: true,
        externalId: true,
        name: true,
        thumbnailUrl: true,
        bannerUrl: true,
        createdAt: true,
        _count: { select: { posts: true } },
      },
    });

    const hasMore = creators.length > limit;
    const page = hasMore ? creators.slice(0, limit) : creators;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    logger.debug('listCreators returning page', { userId, count: page.length, hasMore });
    res.json({ creators: page, nextCursor });
  } catch (err) {
    logger.error('listCreators failed', { userId, error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/v1/creators/:creatorId/posts
 *
 * Returns a paginated list of Posts for the given Creator.
 *
 * Query params:
 *   cursor — id of the last post from the previous page
 *   limit  — page size (max 100, default 50)
 */
export async function listPosts(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { creatorId } = req.params;
  const { cursor } = req.query as Record<string, string | undefined>;
  logger.debug('listPosts called', { creatorId, cursor });

  const limit = Math.min(parseInt((req.query.limit as string) ?? String(PAGE_SIZE), 10), 100);

  try {
    const posts = await prisma.post.findMany({
      where: { creatorId },
      orderBy: { publishedAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        externalId: true,
        publishedAt: true,
        createdAt: true,
        updatedAt: true,
        // Latest *current* revision (revisionExternalId IS NULL, highest id) carries
        // the current title and content.
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
        _count: { select: { attachments: true, comments: true, revisions: true } },
        creator: {
          select: { serviceType: true, externalId: true, name: true },
        },
      },
    });

    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    logger.debug('listPosts returning page', { creatorId, count: page.length, hasMore });
    res.json({ posts: page, nextCursor });
  } catch (err) {
    logger.error('listPosts failed', { creatorId, error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/v1/posts/:postId
 *
 * Returns the full details of a single Post including attachments, comments,
 * revision history, importer tags, and aggregated user-added tags.
 * If a Bearer token is provided the response also marks which user-tags the
 * current user personally added (addedByMe).
 */
export async function getPost(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { postId } = req.params;
  const currentUserId = getUserIdOptional(req);
  logger.debug('getPost called', { postId });

  try {
    const post = await prisma.post.findUnique({
      where: { id: postId },
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
            updatedAt: true,
            // Latest revision (highest id) carries the current content
            revisions: {
              select: { id: true, content: true, createdAt: true },
              orderBy: { id: 'desc' },
            },
          },
          orderBy: [{ publishedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        },
        // All revisions ordered latest-first so the frontend can build a
        // revision picker; [0] is always the current title/content.
        revisions: {
          select: { id: true, title: true, content: true, createdAt: true, revisionExternalId: true },
          orderBy: { id: 'desc' },
        },
        tags: {
          select: { tag: { select: { id: true, name: true } } },
          orderBy: { tag: { name: 'asc' } },
        },
        userTags: {
          select: { tagId: true, userId: true, tag: { select: { id: true, name: true } }, createdAt: true },
          orderBy: { tag: { name: 'asc' } },
        },
        creator: {
          select: { id: true, sourceSite: true, serviceType: true, externalId: true, name: true, thumbnailUrl: true, bannerUrl: true },
        },
      },
    });

    if (!post) {
      logger.warn('getPost: post not found', { postId });
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    // Deduplicate user tags (same tag may be added by multiple users)
    const seenUserTagIds = new Set<string>();
    const userTags: Array<{ tag: { id: string; name: string }; addedByMe: boolean }> = [];
    for (const ut of post.userTags) {
      if (!seenUserTagIds.has(ut.tagId)) {
        seenUserTagIds.add(ut.tagId);
        userTags.push({ tag: ut.tag, addedByMe: ut.userId === currentUserId });
      } else if (ut.userId === currentUserId) {
        const existing = userTags.find((u) => u.tag.id === ut.tagId);
        if (existing) existing.addedByMe = true;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userTags: _rawUserTags, ...postData } = post;
    logger.debug('getPost returning post', { postId });
    res.json({ post: { ...postData, userTags } });
  } catch (err) {
    logger.error('getPost failed', { postId, error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/v1/:serviceType/user/:creatorExternalId
 *
 * Look up a creator by (serviceType, externalId) and return their posts.
 * Optionally scoped to a userId via query param; defaults to first match.
 * If a Bearer token is provided the response includes user-tags for the creator
 * with addedByMe flags.
 */
export async function getCreatorByExternalId(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { serviceType, creatorExternalId } = req.params;
  const { userId, cursor } = req.query as Record<string, string | undefined>;
  const currentUserId = getUserIdOptional(req);
  logger.debug('getCreatorByExternalId called', { serviceType, creatorExternalId, userId });

  const limit = Math.min(parseInt((req.query.limit as string) ?? String(PAGE_SIZE), 10), 100);

  try {
    const creator = await prisma.creator.findFirst({
      where: {
        serviceType,
        externalId: creatorExternalId,
        ...(userId ? { userId } : {}),
      },
      select: {
        id: true,
        userId: true,
        sourceSite: true,
        serviceType: true,
        externalId: true,
        name: true,
        thumbnailUrl: true,
        bannerUrl: true,
        createdAt: true,
        _count: { select: { posts: true } },
        userTags: {
          select: { tagId: true, userId: true, tag: { select: { id: true, name: true } } },
          orderBy: { tag: { name: 'asc' } },
        },
      },
    });

    if (!creator) {
      res.status(404).json({ error: 'Creator not found' });
      return;
    }

    // Deduplicate and annotate user tags
    const seenTagIds = new Set<string>();
    const creatorUserTags: Array<{ tag: { id: string; name: string }; addedByMe: boolean }> = [];
    for (const ut of creator.userTags) {
      if (!seenTagIds.has(ut.tagId)) {
        seenTagIds.add(ut.tagId);
        creatorUserTags.push({ tag: ut.tag, addedByMe: ut.userId === currentUserId });
      } else if (ut.userId === currentUserId) {
        const existing = creatorUserTags.find((u) => u.tag.id === ut.tagId);
        if (existing) existing.addedByMe = true;
      }
    }

    // Fetch paginated posts for this creator
    const posts = await prisma.post.findMany({
      where: { creatorId: creator.id },
      orderBy: { publishedAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        externalId: true,
        publishedAt: true,
        createdAt: true,
        updatedAt: true,
        revisions: {
          where: { revisionExternalId: null },
          orderBy: { id: 'desc' },
          take: 1,
          select: { title: true, content: true },
        },
        tags: {
          select: { tag: { select: { id: true, name: true } } },
          orderBy: { tag: { name: 'asc' } },
        },
        _count: { select: { attachments: true, comments: true, revisions: true } },
        creator: {
          select: { serviceType: true, externalId: true },
        },
      },
    });

    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userTags: _rawUserTags, ...creatorData } = creator;
    res.json({ creator: { ...creatorData, userTags: creatorUserTags }, posts: page, nextCursor });
  } catch (err) {
    logger.error('getCreatorByExternalId failed', {
      serviceType,
      creatorExternalId,
      error: (err as Error).message,
    });
    next(err);
  }
}

/**
 * GET /api/v1/:serviceType/user/:creatorExternalId/post/:postExternalId
 *
 * Look up a post by (serviceType, creatorExternalId, postExternalId).
 * Optionally scoped to a userId via query param; defaults to first match.
 */
export async function getPostByExternalId(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { serviceType, creatorExternalId, postExternalId } = req.params;
  const { userId } = req.query as Record<string, string | undefined>;
  logger.debug('getPostByExternalId called', {
    serviceType,
    creatorExternalId,
    postExternalId,
    userId,
  });

  try {
    const creator = await prisma.creator.findFirst({
      where: {
        serviceType,
        externalId: creatorExternalId,
        ...(userId ? { userId } : {}),
      },
    });

    if (!creator) {
      res.status(404).json({ error: 'Creator not found' });
      return;
    }

    const post = await prisma.post.findUnique({
      where: { creatorId_externalId: { creatorId: creator.id, externalId: postExternalId } },
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
            updatedAt: true,
            revisions: {
              select: { id: true, content: true, createdAt: true },
              orderBy: { id: 'desc' },
            },
          },
          orderBy: [{ publishedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        },
        revisions: {
          select: { id: true, title: true, content: true, createdAt: true, revisionExternalId: true },
          orderBy: { id: 'desc' },
        },
        tags: {
          select: { tag: { select: { id: true, name: true } } },
          orderBy: { tag: { name: 'asc' } },
        },
        creator: {
          select: { id: true, sourceSite: true, serviceType: true, externalId: true, name: true, thumbnailUrl: true, bannerUrl: true },
        },
      },
    });

    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    res.json({ post });
  } catch (err) {
    logger.error('getPostByExternalId failed', {
      serviceType,
      creatorExternalId,
      postExternalId,
      error: (err as Error).message,
    });
    next(err);
  }
}
