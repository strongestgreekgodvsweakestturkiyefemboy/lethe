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
  /** Tags imported from the source platform. */
  tags?: string[];
  /** Discord user snowflake — stored on Post for global user tracking. */
  discordAuthorId?: string;
  /** Discord guild snowflake this channel belongs to. */
  discordGuildId?: string;
  /** Structured Discord author info for DiscordUser upsert. */
  discordAuthorInfo?: {
    discordId: string;
    username?: string | null;
    globalName?: string | null;
    avatarUrl?: string | null;
  } | null;
}

interface DiscordRoleInfo {
  roleId: string;
  name: string;
  color: number;
  position: number;
}

interface DiscordChannelInfo {
  channelId: string;
  name: string;
  type: number;
  parentId?: string | null;
  position: number;
}

interface DiscordServerInfo {
  guildId: string;
  name: string;
  iconUrl?: string | null;
  roles: DiscordRoleInfo[];
  channels: DiscordChannelInfo[];
}

interface UpdateJobBody {
  status: JobStatus;
  progressPct: number;
  newItems?: NewItem[];
  newPosts?: NewPost[];
  logMessage?: string;
  discordServerInfo?: DiscordServerInfo;
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
  const { status, progressPct, newItems, newPosts, logMessage, discordServerInfo } = req.body as UpdateJobBody;
  logger.debug('updateJob called', {
    jobId,
    status,
    progressPct,
    newItemsCount: newItems?.length ?? 0,
    newPostsCount: newPosts?.length ?? 0,
    hasDiscordServerInfo: !!discordServerInfo,
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

    // Upsert Discord server metadata (guild, roles, channels) when provided.
    // This is sent once at job completion from the Discord scraper.
    let discordServerRecord: { id: string } | null = null;
    if (discordServerInfo) {
      discordServerRecord = await upsertDiscordServer(job.userId, discordServerInfo, jobId);
    }

    // Hierarchical posts (kemono/patreon-style) and Discord-native messages
    if (newPosts && newPosts.length > 0) {
      logger.debug('Upserting Posts', { jobId, count: newPosts.length });
      for (const np of newPosts) {

        // -------------------------------------------------------------------
        // Discord-native path: write ONLY to DiscordMessage (and related
        // models).  Discord messages must NOT be stored in Creator/Post tables
        // so they never appear on the /creators or /posts pages.
        // -------------------------------------------------------------------
        if (np.serviceType === 'discord') {
          // Resolve the DiscordServer for this message's guild
          let resolvedServerId: string | null = null;
          if (np.discordGuildId) {
            if (discordServerRecord) {
              resolvedServerId = discordServerRecord.id;
            } else {
              const srv = await prisma.discordServer.findFirst({
                where: { userId: job.userId, guildId: np.discordGuildId },
                select: { id: true },
              });
              resolvedServerId = srv?.id ?? null;
            }
          }

          if (!np.discordGuildId || !resolvedServerId) {
            logger.warn('Discord message missing guild or server record — skipping', {
              jobId,
              messageId: np.externalId,
              guildId: np.discordGuildId ?? null,
            });
            continue;
          }

          const discordChannelRecord = await prisma.discordChannel.findFirst({
            where: { serverId: resolvedServerId, channelId: np.creatorExternalId },
            select: { id: true },
          });

          if (!discordChannelRecord) {
            logger.warn('Discord channel not found in DiscordChannel table — skipping message', {
              jobId,
              channelId: np.creatorExternalId,
              serverId: resolvedServerId,
              messageId: np.externalId,
            });
            continue;
          }

          // Mark channel as visible (it now has imported messages)
          await prisma.discordChannel.update({
            where: { id: discordChannelRecord.id },
            data: { isVisible: true },
          });

          // Upsert DiscordUser (author) if info was provided
          let discordUserRecord: { id: string } | null = null;
          if (np.discordAuthorInfo?.discordId) {
            discordUserRecord = await prisma.discordUser.upsert({
              where: { discordId: np.discordAuthorInfo.discordId },
              create: {
                discordId: np.discordAuthorInfo.discordId,
                username: np.discordAuthorInfo.username ?? null,
                globalName: np.discordAuthorInfo.globalName ?? null,
                avatarUrl: np.discordAuthorInfo.avatarUrl ?? null,
              },
              update: {
                username: np.discordAuthorInfo.username ?? undefined,
                globalName: np.discordAuthorInfo.globalName ?? undefined,
                avatarUrl: np.discordAuthorInfo.avatarUrl ?? undefined,
              },
              select: { id: true },
            });

            // Ensure guild membership record exists
            await prisma.discordGuildMember.upsert({
              where: { guildId_userId: { guildId: resolvedServerId, userId: discordUserRecord.id } },
              create: { guildId: resolvedServerId, userId: discordUserRecord.id },
              update: {},
            });
          }

          // Upsert DiscordMessage
          const existingDiscordMsg = await prisma.discordMessage.findUnique({
            where: {
              channelId_messageId: {
                channelId: discordChannelRecord.id,
                messageId: np.externalId,
              },
            },
            include: {
              revisions: { orderBy: { id: 'desc' }, take: 1 },
            },
          });

          const discordMsg = await prisma.discordMessage.upsert({
            where: {
              channelId_messageId: {
                channelId: discordChannelRecord.id,
                messageId: np.externalId,
              },
            },
            create: {
              messageId: np.externalId,
              channelId: discordChannelRecord.id,
              authorId: discordUserRecord?.id ?? null,
              content: np.content ?? null,
              publishedAt: np.publishedAt ? new Date(np.publishedAt) : null,
            },
            update: {
              content: np.content ?? null,
              publishedAt: np.publishedAt ? new Date(np.publishedAt) : undefined,
              ...(discordUserRecord ? { authorId: discordUserRecord.id } : {}),
            },
            select: { id: true },
          });

          // Write a DiscordMessageRevision if content changed
          const latestDiscordRevision = existingDiscordMsg?.revisions[0];
          if (!latestDiscordRevision || latestDiscordRevision.content !== (np.content ?? null)) {
            await prisma.discordMessageRevision.create({
              data: { messageId: discordMsg.id, content: np.content ?? null },
            });
          }

          // Upsert DiscordAttachments (skip duplicates by fileUrl within this message)
          if (np.attachments && np.attachments.length > 0) {
            const existingMsgUrls = new Set(
              (
                await prisma.discordAttachment.findMany({
                  where: { messageId: discordMsg.id },
                  select: { fileUrl: true },
                })
              ).map((a) => a.fileUrl),
            );
            const newMsgAttachments = np.attachments.filter((a) => !existingMsgUrls.has(a.fileUrl));
            if (newMsgAttachments.length > 0) {
              await prisma.discordAttachment.createMany({
                data: newMsgAttachments.map((a) => ({
                  messageId: discordMsg.id,
                  fileUrl: a.fileUrl,
                  dataType: a.dataType,
                  name: a.name ?? null,
                })),
              });
            }
          }

          // Discord message fully handled — skip the Creator/Post path
          continue;
        }

        // -------------------------------------------------------------------
        // Non-Discord path: Kemono / Patreon-style Creator + Post upsert
        // -------------------------------------------------------------------

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

        // Upsert tags from the source platform
        if (np.tags && np.tags.length > 0) {
          for (const rawName of np.tags) {
            const name = rawName.trim().toLowerCase();
            // Skip blank or overly-long names (same length limit as the admin endpoint)
            if (!name || name.length > 64) continue;
            try {
              const tag = await prisma.tag.upsert({
                where: { name },
                create: { name },
                update: {},
              });
              await prisma.postTag.upsert({
                where: { postId_tagId: { postId: post.id, tagId: tag.id } },
                create: { postId: post.id, tagId: tag.id },
                update: {},
              });
            } catch (tagErr) {
              logger.warn('Failed to upsert tag', {
                jobId,
                postId: post.id,
                tag: rawName,
                error: (tagErr as Error).message,
              });
            }
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

/**
 * Upsert a DiscordServer record (plus its roles and channels) from scraped guild info.
 */
async function upsertDiscordServer(
  userId: string,
  info: DiscordServerInfo,
  jobId: string,
): Promise<{ id: string }> {
  logger.info('Upserting DiscordServer', { jobId, guildId: info.guildId, name: info.name });

  const server = await prisma.discordServer.upsert({
    where: { userId_guildId: { userId, guildId: info.guildId } },
    create: {
      userId,
      guildId: info.guildId,
      name: info.name,
      iconUrl: info.iconUrl ?? null,
    },
    update: {
      name: info.name,
      iconUrl: info.iconUrl ?? null,
    },
    select: { id: true },
  });

  // Upsert roles
  for (const role of info.roles ?? []) {
    try {
      await prisma.discordRole.upsert({
        where: { serverId_roleId: { serverId: server.id, roleId: role.roleId } },
        create: {
          serverId: server.id,
          roleId: role.roleId,
          name: role.name,
          color: role.color,
          position: role.position,
        },
        update: {
          name: role.name,
          color: role.color,
          position: role.position,
        },
      });
    } catch (roleErr) {
      logger.warn('Failed to upsert DiscordRole', {
        jobId,
        roleId: role.roleId,
        error: (roleErr as Error).message,
      });
    }
  }

  // Upsert channels — default isVisible=false; imported channels are set to true
  // when their Creator is processed in the main post loop.
  for (const ch of info.channels ?? []) {
    try {
      await prisma.discordChannel.upsert({
        where: { serverId_channelId: { serverId: server.id, channelId: ch.channelId } },
        create: {
          serverId: server.id,
          channelId: ch.channelId,
          name: ch.name,
          type: ch.type,
          parentId: ch.parentId ?? null,
          position: ch.position,
          isVisible: false,
        },
        update: {
          name: ch.name,
          type: ch.type,
          parentId: ch.parentId ?? null,
          position: ch.position,
        },
      });
    } catch (chErr) {
      logger.warn('Failed to upsert DiscordChannel', {
        jobId,
        channelId: ch.channelId,
        error: (chErr as Error).message,
      });
    }
  }

  logger.info('DiscordServer upserted', {
    jobId,
    serverId: server.id,
    rolesCount: info.roles?.length ?? 0,
    channelsCount: info.channels?.length ?? 0,
  });

  return server;
}
