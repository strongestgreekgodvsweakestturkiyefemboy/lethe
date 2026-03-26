import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { encrypt } from '../utils/crypto';
import { getImportQueue } from '../queues/importQueue';
import { addSseClient, removeSseClient } from '../services/sseManager';
import logger from '../utils/logger';

const prisma = new PrismaClient();

const DEFAULT_USER_ID = 'default';

interface StartImportBody {
  targetSite: string;
  sessionToken: string;
  userId?: string;
}

export async function startImport(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { targetSite, sessionToken, userId: rawUserId } = req.body as StartImportBody;
  const userId = rawUserId?.trim() || DEFAULT_USER_ID;
  logger.debug('startImport called', { targetSite, userId });

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
        status: 'PENDING',
      },
    });
    logger.info('Job created', { jobId: job.id, targetSite, userId });

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
