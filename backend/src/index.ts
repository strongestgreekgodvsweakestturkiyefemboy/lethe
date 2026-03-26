import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { startImport, streamJobStatus } from './controllers/importController';
import { updateJob } from './controllers/internalController';
import { exportItems } from './controllers/exportController';
import { startPeerImport } from './controllers/peerController';
import { listItems, presignFile, listCreators, listPosts, getPost, getCreatorByExternalId, getPostByExternalId } from './controllers/itemsController';
import { login, me } from './controllers/authController';
import {
  listLatestUsers, getPreferences, updatePreferences,
  listFavorites, addFavorite, removeFavorite,
  getFeed, listLatestPosts, searchPosts, searchUsers,
} from './controllers/usersController';
import logger from './utils/logger';

// Catch any promise rejection or exception that escapes route handlers so the
// process never exits silently and always leaves a log trail.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  // Give the logger time to flush before exiting
  setTimeout(() => process.exit(1), 500);
});

const app = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Request / response logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  logger.debug('Incoming request', { method: req.method, url: req.url, ip: req.ip });
  res.on('finish', () => {
    const ms = Date.now() - start;
    logger.debug('Request completed', {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      durationMs: ms,
    });
  });
  next();
});


app.post('/api/v1/imports/start', startImport);
app.get('/api/v1/imports/:jobId/stream', streamJobStatus);
app.post('/api/v1/imports/peer', startPeerImport);
app.get('/api/v1/export/items', exportItems);
app.get('/api/v1/items', listItems);
app.get('/api/v1/files/presign', presignFile);
app.get('/api/v1/creators', listCreators);
app.get('/api/v1/creators/:creatorId/posts', listPosts);
app.get('/api/v1/posts/latest', listLatestPosts);
app.get('/api/v1/posts/:postId', getPost);
// Auth
app.post('/api/v1/auth/login', login);
app.get('/api/v1/auth/me', me);
// Users & social
app.get('/api/v1/users', listLatestUsers);
app.get('/api/v1/users/preferences', getPreferences);
app.put('/api/v1/users/preferences', updatePreferences);
app.get('/api/v1/favorites', listFavorites);
app.post('/api/v1/favorites', addFavorite);
app.delete('/api/v1/favorites/:creatorId', removeFavorite);
app.get('/api/v1/feed', getFeed);
// Search
app.get('/api/v1/search/posts', searchPosts);
app.get('/api/v1/search/users', searchUsers);
// Semantic URL routes: /:serviceType/user/:creatorExternalId[/post/:postExternalId]
app.get('/api/v1/:serviceType/user/:creatorExternalId/post/:postExternalId', getPostByExternalId);
app.get('/api/v1/:serviceType/user/:creatorExternalId', getCreatorByExternalId);
app.post('/api/internal/jobs/:jobId/update', updateJob);

app.get('/healthz', (_req, res) => {
  logger.debug('Health check requested');
  res.json({ status: 'ok' });
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  logger.info(`Backend listening on port ${PORT}`, { port: PORT, logLevel: process.env.LOG_LEVEL ?? 'debug' });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(
      `Port ${PORT} is already in use. ` +
      `Stop the process occupying that port or set a different PORT in .env, then restart.`,
      { port: PORT, code: err.code }
    );
  } else {
    logger.error('Server error', { error: err.message, code: err.code, stack: err.stack });
  }
  // 500 ms matches the flush delay used in the uncaughtException handler above.
  setTimeout(() => process.exit(1), 500);
});

const SHUTDOWN_TIMEOUT_MS = 10_000;

function gracefulShutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down gracefully`);
  // Force-exit after SHUTDOWN_TIMEOUT_MS in case open connections stall server.close().
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
