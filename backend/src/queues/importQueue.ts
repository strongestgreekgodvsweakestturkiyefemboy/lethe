import { Queue } from 'bullmq';
import logger from '../utils/logger';

export interface ImportJobPayload {
  jobId: string;
  userId: string;
  targetSite: string;
  encryptedToken: string;
  /** Set when targetSite === 'lethe_peer' — the remote node's base URL. */
  peerUrl?: string;
}

let importQueue: Queue<ImportJobPayload> | null = null;

interface RedisConnectionConfig {
  host: string;
  port: number;
  password?: string;
  username?: string;
}

function parseRedisConnection(url: string): RedisConnectionConfig {
  const parsed = new URL(url);
  const config: RedisConnectionConfig = {
    host: parsed.hostname || 'localhost',
    port: parseInt(parsed.port || '6379', 10),
  };
  if (parsed.password) {
    config.password = decodeURIComponent(parsed.password);
  }
  if (parsed.username) {
    config.username = decodeURIComponent(parsed.username);
  }
  return config;
}

export function getImportQueue(): Queue<ImportJobPayload> {
  if (!importQueue) {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const connection = parseRedisConnection(redisUrl);
    logger.debug('Initializing import queue', { redisHost: connection.host, redisPort: connection.port });
    importQueue = new Queue<ImportJobPayload>('imports', { connection, prefix: 'bullmq' });
    logger.info('Import queue initialized', { redisHost: connection.host, redisPort: connection.port });
  }
  return importQueue as Queue<ImportJobPayload>;
}
