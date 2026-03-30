import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET ?? 'lethe-dev-secret-change-in-production';

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

interface JwtPayload {
  sub: string;
  username: string;
  isAdmin?: boolean;
}

/** Extract and verify the Bearer JWT from the request. Returns null on failure. */
function verifyToken(req: Request): JwtPayload | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.slice(7), JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

/** Middleware-style helper that rejects non-admin callers. */
async function requireAdmin(req: Request, res: Response): Promise<JwtPayload | null> {
  const payload = verifyToken(req);
  if (!payload) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  // Always re-check against DB so revoked / demoted admins are handled correctly.
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { isAdmin: true },
  });
  if (!user?.isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return null;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Tag management (admin only)
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/tags
 *
 * Returns all tags. Available to every authenticated or unauthenticated user (read access).
 */
export async function listTags(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tags = await prisma.tag.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, createdAt: true, _count: { select: { posts: true } } },
    });
    res.json({ tags });
  } catch (err) {
    logger.error('listTags failed', { error: (err as Error).message });
    next(err);
  }
}

/**
 * POST /api/v1/admin/tags
 *
 * Create a new tag. Admin only.
 * Body: { name: string }
 */
export async function createTag(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  const { name } = req.body as { name?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const cleanName = name.trim().toLowerCase();
  if (!/^[\w\-.: ]{1,64}$/.test(cleanName)) {
    res.status(400).json({ error: 'Tag name must be 1–64 characters: letters, digits, spaces, hyphens, underscores, dots, or colons' });
    return;
  }

  try {
    const tag = await prisma.tag.upsert({
      where: { name: cleanName },
      create: { name: cleanName },
      update: {},
    });
    logger.info('Tag created/found', { tagId: tag.id, name: cleanName });
    res.status(201).json({ tag });
  } catch (err) {
    logger.error('createTag failed', { name: cleanName, error: (err as Error).message });
    next(err);
  }
}

/**
 * DELETE /api/v1/admin/tags/:tagId
 *
 * Delete a tag (and all PostTag associations via cascade). Admin only.
 */
export async function deleteTag(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  const { tagId } = req.params;
  try {
    await prisma.tag.delete({ where: { id: tagId } });
    logger.info('Tag deleted', { tagId });
    res.json({ ok: true });
  } catch (err) {
    logger.error('deleteTag failed', { tagId, error: (err as Error).message });
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Post tag assignment (admin only)
// ---------------------------------------------------------------------------

/**
 * PUT /api/v1/admin/posts/:postId/tags
 *
 * Replace all tags on a post with the provided list. Admin only.
 * Body: { tags: string[] }  — names; tags are created if they don't exist.
 */
export async function replacePostTags(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  const { postId } = req.params;
  const { tags } = req.body as { tags?: string[] };
  if (!Array.isArray(tags)) {
    res.status(400).json({ error: 'tags array is required' });
    return;
  }

  try {
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    // Remove all existing tag associations for this post
    await prisma.postTag.deleteMany({ where: { postId } });

    // Upsert each tag and create the PostTag join row
    const result: { id: string; name: string }[] = [];
    for (const rawName of tags) {
      const name = rawName.trim().toLowerCase();
      if (!name) continue;
      const tag = await prisma.tag.upsert({
        where: { name },
        create: { name },
        update: {},
      });
      await prisma.postTag.upsert({
        where: { postId_tagId: { postId, tagId: tag.id } },
        create: { postId, tagId: tag.id },
        update: {},
      });
      result.push({ id: tag.id, name: tag.name });
    }

    res.json({ tags: result });
  } catch (err) {
    logger.error('replacePostTags failed', { postId, error: (err as Error).message });
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Post management (admin only)
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/admin/posts
 *
 * Returns a paginated list of posts for admin management.
 * Optional query param `q` filters by title/content.
 */
export async function listAdminPosts(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  const q = (req.query.q as string | undefined)?.trim();
  const cursor = req.query.cursor as string | undefined;
  const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10), 100);

  try {
    const posts = await prisma.post.findMany({
      where: q
        ? {
            revisions: {
              some: {
                OR: [
                  { title: { contains: q, mode: 'insensitive' } },
                  { content: { contains: q, mode: 'insensitive' } },
                ],
              },
            },
          }
        : undefined,
      orderBy: { publishedAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        externalId: true,
        publishedAt: true,
        createdAt: true,
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
        creator: { select: { id: true, name: true, serviceType: true, externalId: true } },
        _count: { select: { attachments: true, comments: true } },
      },
    });

    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;
    res.json({ posts: page, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (err) {
    logger.error('listAdminPosts failed', { error: (err as Error).message });
    next(err);
  }
}

/**
 * PATCH /api/v1/admin/posts/:postId
 *
 * Edit a post's title and/or content by creating a new PostRevision. Admin only.
 * Body: { title?: string; content?: string }
 */
export async function editPost(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  const { postId } = req.params;
  const { title, content } = req.body as { title?: string; content?: string };

  if (title === undefined && content === undefined) {
    res.status(400).json({ error: 'Provide at least one of title or content' });
    return;
  }

  try {
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const revision = await prisma.postRevision.create({
      data: { postId, title: title ?? null, content: content ?? null },
    });
    logger.info('Post edited by admin', { postId, revisionId: revision.id });
    res.json({ revision });
  } catch (err) {
    logger.error('editPost failed', { postId, error: (err as Error).message });
    next(err);
  }
}

/**
 * DELETE /api/v1/admin/posts/:postId
 *
 * Delete a post and all its attachments, comments, revisions, and tags. Admin only.
 * PostTag rows cascade automatically (onDelete: Cascade on the FK).
 */
export async function deletePost(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  const { postId } = req.params;
  try {
    // Delete comment revisions first (no cascade defined on CommentRevision), then
    // comments, post revisions, attachments, and finally the post itself.
    // PostTag rows are handled by onDelete: Cascade.
    await prisma.$transaction(async (tx) => {
      const comments = await tx.comment.findMany({ where: { postId }, select: { id: true } });
      for (const c of comments) {
        await tx.commentRevision.deleteMany({ where: { commentId: c.id } });
      }
      await tx.comment.deleteMany({ where: { postId } });
      await tx.postAttachment.deleteMany({ where: { postId } });
      await tx.postRevision.deleteMany({ where: { postId } });
      await tx.post.delete({ where: { id: postId } });
    });
    logger.info('Post deleted by admin', { postId });
    res.json({ ok: true });
  } catch (err) {
    logger.error('deletePost failed', { postId, error: (err as Error).message });
    next(err);
  }
}

/**
 * DELETE /api/v1/admin/creators/:creatorId
 *
 * Delete a creator and all their posts (with full cascade). Admin only.
 */
export async function deleteCreator(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  const { creatorId } = req.params;
  try {
    await prisma.$transaction(async (tx) => {
      const posts = await tx.post.findMany({ where: { creatorId }, select: { id: true } });
      for (const post of posts) {
        const comments = await tx.comment.findMany({ where: { postId: post.id }, select: { id: true } });
        for (const c of comments) {
          await tx.commentRevision.deleteMany({ where: { commentId: c.id } });
        }
        await tx.comment.deleteMany({ where: { postId: post.id } });
        await tx.postAttachment.deleteMany({ where: { postId: post.id } });
        await tx.postRevision.deleteMany({ where: { postId: post.id } });
        // PostTag rows cascade automatically
      }
      await tx.post.deleteMany({ where: { creatorId } });
      await tx.userFavorite.deleteMany({ where: { creatorId } });
      await tx.creator.delete({ where: { id: creatorId } });
    });
    logger.info('Creator deleted by admin', { creatorId });
    res.json({ ok: true });
  } catch (err) {
    logger.error('deleteCreator failed', { creatorId, error: (err as Error).message });
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Jobs management (admin only)
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/admin/jobs
 *
 * Returns a paginated list of all import jobs for admin management.
 */
export async function listAdminJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  const cursor = req.query.cursor as string | undefined;
  const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10), 100);
  const statusFilter = req.query.status as string | undefined;

  try {
    const jobs = await prisma.job.findMany({
      where: statusFilter ? { status: statusFilter as any } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        targetSite: true,
        status: true,
        progressPct: true,
        errorMessage: true,
        saveSession: true,
        creatorExternalId: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, username: true } },
      },
    });

    const hasMore = jobs.length > limit;
    const page = hasMore ? jobs.slice(0, limit) : jobs;
    res.json({ jobs: page, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (err) {
    logger.error('listAdminJobs failed', { error: (err as Error).message });
    next(err);
  }
}

/**
 * POST /api/v1/admin/jobs/:jobId/reimport
 *
 * Force-reimport a job that has a saved session token. Admin only.
 */
export async function forceReimport(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  const { jobId } = req.params;
  try {
    const originalJob = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        userId: true,
        targetSite: true,
        creatorExternalId: true,
        saveSession: true,
        savedToken: true,
      },
    });

    if (!originalJob) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    if (!originalJob.saveSession || !originalJob.savedToken) {
      res.status(400).json({ error: 'Job does not have a saved session token' });
      return;
    }

    // Import the queue dynamically to avoid circular deps at module level
    const { getImportQueue } = await import('../queues/importQueue');

    const newJob = await prisma.job.create({
      data: {
        userId: originalJob.userId,
        targetSite: originalJob.targetSite,
        creatorExternalId: originalJob.creatorExternalId ?? null,
        status: 'PENDING',
        saveSession: true,
        savedToken: originalJob.savedToken,
      },
    });

    const queue = getImportQueue();
    await queue.add('import', {
      jobId: newJob.id,
      userId: originalJob.userId,
      targetSite: originalJob.targetSite,
      encryptedToken: originalJob.savedToken,
    });

    logger.info('Admin force-reimport enqueued', { originalJobId: jobId, newJobId: newJob.id });
    res.status(201).json({ jobId: newJob.id });
  } catch (err) {
    logger.error('forceReimport failed', { jobId, error: (err as Error).message });
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Discord channel visibility (admin only)
// ---------------------------------------------------------------------------

/**
 * PATCH /api/v1/admin/channels/:channelId/visibility
 *
 * Toggle a Discord channel's isVisible flag. Admin only.
 * Body: { isVisible: boolean }
 */
export async function setChannelVisibility(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  const { channelId } = req.params;
  const { isVisible } = req.body as { isVisible?: boolean };

  if (typeof isVisible !== 'boolean') {
    res.status(400).json({ error: 'isVisible (boolean) is required' });
    return;
  }

  try {
    const channel = await prisma.discordChannel.update({
      where: { id: channelId },
      data: { isVisible },
      select: { id: true, name: true, isVisible: true },
    });
    logger.info('Channel visibility updated', { channelId, isVisible });
    res.json({ channel });
  } catch (err) {
    logger.error('setChannelVisibility failed', { channelId, error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/v1/admin/discord/servers/:serverId/channels
 *
 * List all channels for a Discord server with their visibility status. Admin only.
 */
export async function listServerChannels(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  const { serverId } = req.params;
  try {
    const channels = await prisma.discordChannel.findMany({
      where: { serverId },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      select: { id: true, channelId: true, name: true, type: true, isVisible: true, parentId: true, position: true },
    });
    res.json({ channels });
  } catch (err) {
    logger.error('listServerChannels failed', { serverId, error: (err as Error).message });
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Site branding (admin only)
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/admin/branding
 *
 * Get site branding settings (or defaults if not yet configured). Admin only.
 */
export async function getBranding(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  try {
    const branding = await prisma.siteBranding.upsert({
      where: { id: 'singleton' },
      create: {},
      update: {},
    });
    res.json({ branding });
  } catch (err) {
    logger.error('getBranding failed', { error: (err as Error).message });
    next(err);
  }
}

/**
 * PUT /api/v1/admin/branding
 *
 * Update site branding settings. Admin only.
 * Body: { siteName?, siteTagline?, accentColor?, logoUrl? }
 */
export async function updateBranding(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  const { siteName, siteTagline, accentColor, logoUrl } = req.body as {
    siteName?: string;
    siteTagline?: string;
    accentColor?: string;
    logoUrl?: string | null;
  };

  try {
    const branding = await prisma.siteBranding.upsert({
      where: { id: 'singleton' },
      create: {
        ...(siteName !== undefined && { siteName }),
        ...(siteTagline !== undefined && { siteTagline }),
        ...(accentColor !== undefined && { accentColor }),
        ...(logoUrl !== undefined && { logoUrl }),
      },
      update: {
        ...(siteName !== undefined && { siteName }),
        ...(siteTagline !== undefined && { siteTagline }),
        ...(accentColor !== undefined && { accentColor }),
        ...(logoUrl !== undefined && { logoUrl }),
      },
    });
    logger.info('Site branding updated', { siteName, accentColor });
    res.json({ branding });
  } catch (err) {
    logger.error('updateBranding failed', { error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/v1/branding
 *
 * Public endpoint to get site branding (so any page can display it).
 */
export async function getPublicBranding(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const branding = await prisma.siteBranding.findUnique({ where: { id: 'singleton' } });
    res.json({
      branding: branding ?? {
        siteName: 'Lethe',
        siteTagline: 'Self-hosted data archival service',
        accentColor: '#6366f1',
        logoUrl: null,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Importer settings (admin)
// ---------------------------------------------------------------------------

/** The canonical list of public-facing importers that can be enabled/disabled. */
export const ALL_IMPORTERS = [
  'kemono',
  'patreon',
  'fanbox',
  'gumroad',
  'subscribestar',
  'onlyfans',
  'fansly',
  'boosty',
  'dlsite',
  'discord',
  'fantia',
] as const;

/**
 * GET /api/v1/admin/importers
 *
 * Returns all importers with their enabled/disabled state. Admin only.
 */
export async function listImporterSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  try {
    const rows = await prisma.importerSetting.findMany();
    const settingsMap = Object.fromEntries(rows.map((r) => [r.id, r.enabled]));

    const importers = ALL_IMPORTERS.map((id) => ({
      id,
      enabled: settingsMap[id] !== undefined ? settingsMap[id] : true,
    }));

    res.json({ importers });
  } catch (err) {
    logger.error('listImporterSettings failed', { error: (err as Error).message });
    next(err);
  }
}

/**
 * PATCH /api/v1/admin/importers/:importerId
 *
 * Enable or disable an importer. Admin only.
 * Body: { enabled: boolean }
 */
export async function updateImporterSetting(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await requireAdmin(req, res))) return;

  const { importerId } = req.params;
  const { enabled } = req.body as { enabled?: boolean };

  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) is required' });
    return;
  }

  if (!(ALL_IMPORTERS as readonly string[]).includes(importerId)) {
    res.status(404).json({ error: 'Unknown importer' });
    return;
  }

  try {
    const setting = await prisma.importerSetting.upsert({
      where: { id: importerId },
      create: { id: importerId, enabled },
      update: { enabled },
    });
    logger.info('Importer setting updated', { importerId, enabled });
    res.json({ importer: { id: setting.id, enabled: setting.enabled } });
  } catch (err) {
    logger.error('updateImporterSetting failed', { importerId, error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/v1/importers
 *
 * Public endpoint that returns which importers are currently enabled.
 * Used by the import form to show only available importers.
 */
export async function getPublicImporterSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.importerSetting.findMany();
    const settingsMap = Object.fromEntries(rows.map((r) => [r.id, r.enabled]));

    const importers = ALL_IMPORTERS.map((id) => ({
      id,
      enabled: settingsMap[id] !== undefined ? settingsMap[id] : true,
    }));

    res.json({ importers });
  } catch (err) {
    next(err);
  }
}
