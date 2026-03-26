import { Request, Response, NextFunction } from 'express';
import { PrismaClient, DataType, JobStatus } from '@prisma/client';
import { broadcastJobUpdate } from '../services/sseManager';
import logger from '../utils/logger';

const prisma = new PrismaClient();

interface NewItem {
  dataType: DataType;
  content?: string;
  fileUrl?: string;
  sourcePostId?: string;
  publishedAt?: string;
  sourceSite?: string;
}

interface NewAttachment {
  fileUrl: string;
  dataType: DataType;
  name?: string;
}

interface NewComment {
  externalId: string;
  content: string;
  authorName?: string;
  publishedAt?: string;
}

interface NewPostRevision {
  title?: string;
  content?: string;
  publishedAt?: string;
  revisionExternalId?: string;
}

interface NewPost {
  externalId: string;
  creatorExternalId: string;
  serviceType: string;
  title?: string;
  content?: string;
  publishedAt?: string;
  attachments?: NewAttachment[];
  comments?: NewComment[];
  /** Historical revisions imported from the source platform. */
  historicalRevisions?: NewPostRevision[];
  /** Creator display name from the source platform. */
  creatorName?: string;
  /** Creator avatar/thumbnail S3 key (or external URL fallback). */
  creatorThumbnailUrl?: string;
  /** Creator banner/header S3 key. */
  creatorBannerUrl?: string;
}

interface UpdateJobBody {
  status: JobStatus;
  progressPct: number;
  newItems?: NewItem[];
  newPosts?: NewPost[];
  logMessage?: string;
}

export async function updateJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  const secret = req.headers['x-internal-secret'];
  if (secret !== process.env.INTERNAL_WEBHOOK_SECRET) {
    logger.warn('updateJob: unauthorized request (bad internal secret)', {
      jobId: req.params.jobId,
      ip: req.ip,
    });
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const { jobId } = req.params;
  const { status, progressPct, newItems, newPosts, logMessage } = req.body as UpdateJobBody;
  logger.debug('updateJob called', {
    jobId,
    status,
    progressPct,
    newItemsCount: newItems?.length ?? 0,
    newPostsCount: newPosts?.length ?? 0,
  });

  try {
    const job = await prisma.job.update({
      where: { id: jobId },
      data: { status, progressPct },
    });
    logger.info('Job status updated', { jobId, status, progressPct, userId: job.userId });

    // Legacy flat items (site_a, lethe_peer, etc.)
    if (newItems && newItems.length > 0) {
      logger.debug('Creating DataItems', { jobId, count: newItems.length });
      await prisma.dataItem.createMany({
        data: newItems.map((item) => ({
          userId: job.userId,
          sourceSite: item.sourceSite ?? job.targetSite,
          dataType: item.dataType,
          content: item.content,
          fileUrl: item.fileUrl,
          sourcePostId: item.sourcePostId,
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : undefined,
        })),
      });
      logger.info('DataItems created', { jobId, count: newItems.length });
    }

    // Hierarchical posts (kemono/patreon-style)
    if (newPosts && newPosts.length > 0) {
      logger.debug('Upserting Posts', { jobId, count: newPosts.length });
      for (const np of newPosts) {
        // Upsert Creator
        const creator = await prisma.creator.upsert({
          where: {
            userId_serviceType_externalId: {
              userId: job.userId,
              serviceType: np.serviceType,
              externalId: np.creatorExternalId,
            },
          },
          create: {
            userId: job.userId,
            sourceSite: job.targetSite,
            serviceType: np.serviceType,
            externalId: np.creatorExternalId,
            name: np.creatorName ?? null,
            thumbnailUrl: np.creatorThumbnailUrl ?? null,
            bannerUrl: np.creatorBannerUrl ?? null,
          },
          update: {
            name: np.creatorName ?? null,
            thumbnailUrl: np.creatorThumbnailUrl ?? null,
            bannerUrl: np.creatorBannerUrl ?? null,
          },
        });

        // Find existing post with its latest *current* revision (revisionExternalId IS NULL)
        // so we can decide whether new content differs (avoiding spurious revision rows).
        const existingPost = await prisma.post.findUnique({
          where: { creatorId_externalId: { creatorId: creator.id, externalId: np.externalId } },
          include: {
            revisions: {
              where: { revisionExternalId: null },
              orderBy: { id: 'desc' },
              take: 1,
            },
          },
        });

        // Upsert Post — title/content live in PostRevision only
        const post = await prisma.post.upsert({
          where: { creatorId_externalId: { creatorId: creator.id, externalId: np.externalId } },
          create: {
            creatorId: creator.id,
            externalId: np.externalId,
            publishedAt: np.publishedAt ? new Date(np.publishedAt) : undefined,
          },
          update: {
            publishedAt: np.publishedAt ? new Date(np.publishedAt) : undefined,
          },
        });

        // Upsert historical revisions FIRST (oldest-first as provided by the scraper)
        // so they get lower row IDs than the current revision.  Each revision is
        // identified by its source-platform ID so re-imports are idempotent.
        for (const hr of np.historicalRevisions ?? []) {
          if (!hr.revisionExternalId) continue;
          try {
            await prisma.postRevision.upsert({
              where: {
                postId_revisionExternalId: {
                  postId: post.id,
                  revisionExternalId: hr.revisionExternalId,
                },
              },
              create: {
                postId: post.id,
                title: hr.title,
                content: hr.content,
                revisionExternalId: hr.revisionExternalId,
              },
              update: {},
            });
          } catch (revErr) {
            logger.warn('Failed to upsert historical revision', {
              jobId,
              postId: post.id,
              revisionExternalId: hr.revisionExternalId,
              error: (revErr as Error).message,
            });
          }
        }

        // Create a current PostRevision (revisionExternalId = null) whenever
        // this is a new post or the content has changed.  This revision is
        // written AFTER the historical ones so it always has the highest ID
        // and is returned first by `orderBy: { id: 'desc' }`.
        const latestRevision = existingPost?.revisions[0];
        const newTitle = np.title ?? null;
        const newContent = np.content ?? null;
        if (
          !latestRevision ||
          latestRevision.title !== newTitle ||
          latestRevision.content !== newContent
        ) {
          await prisma.postRevision.create({
            data: { postId: post.id, title: np.title, content: np.content },
          });
          logger.debug('PostRevision created', { jobId, postId: post.id });
        }

        // Create attachments (skip duplicates by fileUrl within this post)
        if (np.attachments && np.attachments.length > 0) {
          const existingUrls = new Set(
            (
              await prisma.postAttachment.findMany({
                where: { postId: post.id },
                select: { fileUrl: true },
              })
            ).map((a) => a.fileUrl),
          );
          const newAttachments = np.attachments.filter((a) => !existingUrls.has(a.fileUrl));
          if (newAttachments.length > 0) {
            await prisma.postAttachment.createMany({
              data: newAttachments.map((a) => ({
                postId: post.id,
                fileUrl: a.fileUrl,
                dataType: a.dataType,
                name: a.name,
              })),
            });
          }
        }

        // Upsert Comments — content lives in CommentRevision only
        for (const nc of np.comments ?? []) {
          const existingComment = await prisma.comment.findUnique({
            where: { postId_externalId: { postId: post.id, externalId: nc.externalId } },
            include: {
              revisions: {
                orderBy: { id: 'desc' },
                take: 1,
              },
            },
          });

          const comment = await prisma.comment.upsert({
            where: { postId_externalId: { postId: post.id, externalId: nc.externalId } },
            create: {
              postId: post.id,
              externalId: nc.externalId,
              authorName: nc.authorName,
              publishedAt: nc.publishedAt ? new Date(nc.publishedAt) : undefined,
            },
            update: {
              authorName: nc.authorName,
              publishedAt: nc.publishedAt ? new Date(nc.publishedAt) : undefined,
            },
          });

          // Create a CommentRevision whenever this is a new comment or content has changed
          const latestCommentRevision = existingComment?.revisions[0];
          if (!latestCommentRevision || latestCommentRevision.content !== nc.content) {
            await prisma.commentRevision.create({
              data: { commentId: comment.id, content: nc.content },
            });
            logger.debug('CommentRevision created', { jobId, commentId: comment.id });
          }
        }
      }
      logger.info('Posts upserted', { jobId, count: newPosts.length });
    }

    broadcastJobUpdate(jobId, { status, progressPct, logMessage });
    logger.debug('SSE broadcast sent', { jobId, status, progressPct, logMessage });

    res.json({ ok: true });
  } catch (err) {
    logger.error('updateJob failed', { jobId, error: (err as Error).message });
    next(err);
  }
}
