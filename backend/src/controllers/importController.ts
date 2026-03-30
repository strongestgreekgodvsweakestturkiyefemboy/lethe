import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { encrypt } from '../utils/crypto';
import { getImportQueue } from '../queues/importQueue';
import { addSseClient, removeSseClient } from '../services/sseManager';
import logger from '../utils/logger';

const prisma = new PrismaClient();

const DEFAULT_USER_ID = 'default';
/** Minimum milliseconds between imports of the same creator by the same user. */
const IMPORT_THROTTLE_MS = 90 * 60 * 1000; // 90 minutes

interface StartImportBody {
  targetSite: string;
  sessionToken: string;
  userId?: string;
  /** Optional creator/channel identifier used for the 90-min throttle. */
  creatorExternalId?: string;
  /** When true, store the encrypted session token on the job for auto-reimport. */
  saveSession?: boolean;
}

export async function startImport(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { targetSite, sessionToken, userId: rawUserId, creatorExternalId, saveSession } = req.body as StartImportBody;
  const userId = rawUserId?.trim() || DEFAULT_USER_ID;
  logger.debug('startImport called', { targetSite, userId, creatorExternalId });

  if (!targetSite || !sessionToken) {
    logger.warn('startImport: missing required fields', { targetSite, userId, hasToken: !!sessionToken });
    res.status(400).json({ error: 'targetSite and sessionToken are required' });
    return;
  }

  if (!/^[\w\-]{1,128}$/.test(userId)) {
    logger.warn('startImport: invalid userId format', { userId });
    res.status(400).json({ error: 'userId must be 1–128 alphanumeric characters, hyphens, or underscores' });
    return;
  }

  try {
    // Check if the requested importer is enabled.
    const importerSetting = await prisma.importerSetting.findUnique({ where: { id: targetSite } });
    if (importerSetting !== null && !importerSetting.enabled) {
      logger.warn('startImport: importer disabled', { targetSite, userId });
      res.status(400).json({ error: `The '${targetSite}' importer is currently disabled` });
      return;
    }

    // Throttle: if a creatorExternalId is provided, reject if a recent job exists for the same
    // (userId, targetSite, creatorExternalId) triple within the cooldown window.
    if (creatorExternalId) {
      const since = new Date(Date.now() - IMPORT_THROTTLE_MS);
      const recentJob = await prisma.job.findFirst({
        where: {
          userId,
          targetSite,
          creatorExternalId,
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (recentJob) {
        const retryAfterMs = IMPORT_THROTTLE_MS - (Date.now() - recentJob.createdAt.getTime());
        const retryAfterSec = Math.ceil(retryAfterMs / 1000);
        logger.warn('startImport: throttled', { userId, targetSite, creatorExternalId, retryAfterSec });
        res.setHeader('Retry-After', String(retryAfterSec));
        res.status(429).json({
          error: 'Import throttled. Please wait before importing the same creator again.',
          retryAfterSeconds: retryAfterSec,
        });
        return;
      }
    }

    logger.debug('Encrypting session token', { targetSite, userId });
    const encryptedToken = encrypt(sessionToken);

    logger.debug('Upserting user record', { userId });
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId },
    });

    logger.debug('Creating job record in DB', { targetSite, userId });
    const job = await prisma.job.create({
      data: {
        userId,
        targetSite,
        creatorExternalId: creatorExternalId ?? null,
        status: 'PENDING',
        saveSession: saveSession === true,
        savedToken: saveSession === true ? encryptedToken : null,
      },
    });
    logger.info('Job created', { jobId: job.id, targetSite, userId, saveSession: saveSession === true });

    const queue = getImportQueue();
    await queue.add('import', {
      jobId: job.id,
      userId,
      targetSite,
      encryptedToken,
    });
    logger.info('Job enqueued', { jobId: job.id, targetSite, userId });

    res.status(201).json({ jobId: job.id });
  } catch (err) {
    logger.error('startImport failed', { targetSite, userId, error: (err as Error).message });
    next(err);
  }
}

export function streamJobStatus(req: Request, res: Response): void {
  const { jobId } = req.params;
  logger.debug('SSE stream requested', { jobId });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  addSseClient(jobId, res);

  res.write(`data: ${JSON.stringify({ connected: true, jobId })}\n\n`);
  logger.debug('SSE client connected', { jobId });

  req.on('close', () => {
    removeSseClient(jobId, res);
    logger.debug('SSE client disconnected', { jobId });
  });
}
