import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { encrypt } from '../utils/crypto';
import { getImportQueue } from '../queues/importQueue';
import logger from '../utils/logger';

const prisma = new PrismaClient();

interface PeerImportBody {
  /** Base URL of the remote Lethe node, e.g. "https://other.example.com" */
  peerUrl: string;
  /** Export API key issued by the remote node */
  apiKey: string;
  /** Local user id to attach the imported DataItems to */
  userId: string;
}

/**
 * POST /api/v1/imports/peer
 *
 * Starts an import job that fetches DataItems from another running Lethe
 * instance via that node's GET /api/v1/export/items endpoint.
 */
export async function startPeerImport(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { peerUrl, apiKey, userId } = req.body as PeerImportBody;
  logger.debug('startPeerImport called', { peerUrl, userId });

  if (!peerUrl || !apiKey || !userId) {
    logger.warn('startPeerImport: missing required fields', { peerUrl, userId, hasApiKey: !!apiKey });
    res.status(400).json({ error: 'peerUrl, apiKey, and userId are required' });
    return;
  }

  if (!/^[\w\-]{1,128}$/.test(userId)) {
    logger.warn('startPeerImport: invalid userId format', { userId });
    res.status(400).json({ error: 'userId must be 1–128 alphanumeric characters, hyphens, or underscores' });
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(peerUrl);
  } catch {
    logger.warn('startPeerImport: invalid peerUrl', { peerUrl });
    res.status(400).json({ error: 'peerUrl must be a valid URL' });
    return;
  }

  try {
    logger.debug('Encrypting peer API key', { peerUrl: parsedUrl.origin, userId });
    const encryptedToken = encrypt(apiKey);

    logger.debug('Upserting user record', { userId });
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId, email: `${userId}@lethe.local` },
    });

    logger.debug('Creating peer import job record in DB', { peerUrl: parsedUrl.origin, userId });
    const job = await prisma.job.create({
      data: {
        userId,
        targetSite: 'lethe_peer',
        status: 'PENDING',
      },
    });
    logger.info('Peer import job created', { jobId: job.id, peerUrl: parsedUrl.origin, userId });

    const queue = getImportQueue();
    await queue.add('import', {
      jobId: job.id,
      userId,
      targetSite: 'lethe_peer',
      encryptedToken,
      peerUrl: parsedUrl.origin,
    });
    logger.info('Peer import job enqueued', { jobId: job.id, peerUrl: parsedUrl.origin, userId });

    res.status(201).json({ jobId: job.id });
  } catch (err) {
    logger.error('startPeerImport failed', { peerUrl: parsedUrl.origin, userId, error: (err as Error).message });
    next(err);
  }
}
