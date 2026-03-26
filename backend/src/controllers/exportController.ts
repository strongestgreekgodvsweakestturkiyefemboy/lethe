import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';

const prisma = new PrismaClient();

const PAGE_SIZE = 50;

/**
 * GET /api/v1/export/items
 *
 * Returns a paginated list of DataItems belonging to the authenticated user
 * (or all items when called without a userId filter). Protected by API key.
 *
 * Query params:
 *   cursor   — id of the last item from the previous page (for keyset pagination)
 *   userId   — optional filter
 *   dataType — optional filter (TEXT | IMAGE | VIDEO | AUDIO)
 *   limit    — page size (max 100, default 50)
 */
export async function exportItems(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.EXPORT_API_KEY) {
    logger.warn('exportItems: unauthorized request (bad API key)', { ip: req.ip });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { cursor, userId, dataType } = req.query as Record<string, string | undefined>;
  const limit = Math.min(parseInt((req.query.limit as string) ?? String(PAGE_SIZE), 10), 100);
  logger.debug('exportItems called', { userId, dataType, cursor, limit });

  try {
    const items = await prisma.dataItem.findMany({
      where: {
        ...(userId ? { userId } : {}),
        ...(dataType ? { dataType: dataType as 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: limit + 1,
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
      select: {
        id: true,
        userId: true,
        sourceSite: true,
        dataType: true,
        content: true,
        fileUrl: true,
        createdAt: true,
      },
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    logger.debug('exportItems returning page', { count: page.length, hasMore, nextCursor });
    res.json({ items: page, nextCursor });
  } catch (err) {
    logger.error('exportItems failed', { error: (err as Error).message });
    next(err);
  }
}
