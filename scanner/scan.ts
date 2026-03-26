import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { S3Client, HeadObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';
import logger from './logger';

const prisma = new PrismaClient();

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

async function checkObjectExists(key: string): Promise<boolean> {
  logger.debug('Checking S3 object existence', { bucket: BUCKET, key });
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    logger.debug('S3 object exists', { key });
    return true;
  } catch (err) {
    if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404) {
      logger.debug('S3 object not found', { key });
      return false;
    }
    logger.error('S3 HeadObject error', { key, error: (err as Error).message });
    throw err;
  }
}

async function main(): Promise<void> {
  logger.info('Starting reconciliation scan', { bucket: BUCKET });

  const items = await prisma.dataItem.findMany({
    where: { fileUrl: { not: null } },
    select: { id: true, fileUrl: true, userId: true, sourceSite: true },
  });

  logger.info(`Found ${items.length} DataItem(s) with fileUrl`, { count: items.length });

  let orphaned = 0;

  for (const item of items) {
    if (!item.fileUrl) continue;
    try {
      const exists = await checkObjectExists(item.fileUrl);
      if (!exists) {
        orphaned++;
        logger.warn('Orphaned DataItem detected', {
          id: item.id,
          userId: item.userId,
          sourceSite: item.sourceSite,
          fileUrl: item.fileUrl,
        });
      } else {
        logger.debug('DataItem S3 object OK', { id: item.id, fileUrl: item.fileUrl });
      }
    } catch (err) {
      logger.error('Error checking DataItem', {
        id: item.id,
        fileUrl: item.fileUrl,
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
    }
  }

  logger.info('Scan complete', { orphaned, total: items.length });
  await prisma.$disconnect();
}

main().catch(async (err) => {
  logger.error('Fatal error in scanner', { error: (err as Error).message, stack: (err as Error).stack });
  await prisma.$disconnect();
  process.exit(1);
});
