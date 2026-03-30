import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { startImport, streamJobStatus } from './controllers/importController';
import { updateJob } from './controllers/internalController';
import { exportItems } from './controllers/exportController';
import { startPeerImport } from './controllers/peerController';
import { getDiscordGuilds, getDiscordGuildChannels } from './controllers/discordController';
import { listDiscordServers, getDiscordServer } from './controllers/discordServerController';
import { listChannelMessages, listUserMessages } from './controllers/discordMessagesController';
import { listItems, presignFile, listCreators, listPosts, getPost, getCreatorByExternalId, getPostByExternalId } from './controllers/itemsController';
import { login, me, changePassword } from './controllers/authController';
import {
  listLatestUsers, getPreferences, updatePreferences,
  listFavorites, addFavorite, removeFavorite,
  getFeed, listLatestPosts, searchPosts,
} from './controllers/usersController';
import {
  listTags, createTag, deleteTag,
  replacePostTags,
  listAdminPosts, editPost, deletePost, deleteCreator,
  listAdminJobs, forceReimport,
  setChannelVisibility, listServerChannels,
  getBranding, updateBranding, getPublicBranding,
  listImporterSettings, updateImporterSetting, getPublicImporterSettings,
} from './controllers/adminController';
import {
  addUserPostTag, removeUserPostTag,
  addUserCreatorTag, removeUserCreatorTag, listCreatorTags,
  addUserDiscordServerTag, removeUserDiscordServerTag, listDiscordServerTags,
} from './controllers/tagsController';
import {
  listPublicCreators,
  getPublicCreator,
  listPublicPosts,
  getPublicPost,
  listPublicLatestPosts,
} from './controllers/publicController';
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
// Discord server/channel discovery proxy
app.post('/api/v1/discord/guilds', getDiscordGuilds);
app.post('/api/v1/discord/guilds/:guildId/channels', getDiscordGuildChannels);
// Discord archived server data
app.get('/api/v1/discord/servers', listDiscordServers);
app.get('/api/v1/discord/servers/:serverId', getDiscordServer);
// Discord native message API (new Discord-specific models)
app.get('/api/v1/discord/servers/:serverId/channels/:channelId/messages', listChannelMessages);
app.get('/api/v1/discord/users/:discordUserId/messages', listUserMessages);
app.get('/api/v1/items', listItems);
app.get('/api/v1/files/presign', presignFile);
app.get('/api/v1/creators', listCreators);
app.get('/api/v1/creators/:creatorId/posts', listPosts);
app.get('/api/v1/posts/latest', listLatestPosts);
app.get('/api/v1/posts/:postId', getPost);
// Auth
app.post('/api/v1/auth/login', login);
app.get('/api/v1/auth/me', me);
app.patch('/api/v1/auth/password', changePassword);
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
// Users are not publicly searchable — endpoint removed
// app.get('/api/v1/search/users', searchUsers);
// Tags (read — any authenticated or unauthenticated user)
app.get('/api/v1/tags', listTags);
// User-defined tags on posts (logged-in users)
app.post('/api/v1/posts/:postId/tags', addUserPostTag);
app.delete('/api/v1/posts/:postId/tags/:tagId', removeUserPostTag);
// User-defined tags on creators (logged-in users)
app.get('/api/v1/creators/:creatorId/tags', listCreatorTags);
app.post('/api/v1/creators/:creatorId/tags', addUserCreatorTag);
app.delete('/api/v1/creators/:creatorId/tags/:tagId', removeUserCreatorTag);
// User-defined tags on Discord servers (logged-in users)
app.get('/api/v1/discord/servers/:serverId/tags', listDiscordServerTags);
app.post('/api/v1/discord/servers/:serverId/tags', addUserDiscordServerTag);
app.delete('/api/v1/discord/servers/:serverId/tags/:tagId', removeUserDiscordServerTag);
// Public branding (no auth required)
app.get('/api/v1/branding', getPublicBranding);
// Admin endpoints
app.get('/api/v1/admin/posts', listAdminPosts);
app.post('/api/v1/admin/tags', createTag);
app.delete('/api/v1/admin/tags/:tagId', deleteTag);
app.put('/api/v1/admin/posts/:postId/tags', replacePostTags);
app.patch('/api/v1/admin/posts/:postId', editPost);
app.delete('/api/v1/admin/posts/:postId', deletePost);
app.delete('/api/v1/admin/creators/:creatorId', deleteCreator);
app.get('/api/v1/admin/jobs', listAdminJobs);
app.post('/api/v1/admin/jobs/:jobId/reimport', forceReimport);
app.patch('/api/v1/admin/channels/:channelId/visibility', setChannelVisibility);
app.get('/api/v1/admin/discord/servers/:serverId/channels', listServerChannels);
app.get('/api/v1/admin/branding', getBranding);
app.put('/api/v1/admin/branding', updateBranding);
app.get('/api/v1/admin/importers', listImporterSettings);
app.patch('/api/v1/admin/importers/:importerId', updateImporterSetting);
// Public read-only API — no authentication required
app.get('/api/v1/importers', getPublicImporterSettings);
app.get('/api/v1/creators.json', listPublicCreators);
app.get('/api/v1/posts/latest.json', listPublicLatestPosts);
app.get('/api/v1/creators/:service/:creatorExternalId', getPublicCreator);
app.get('/api/v1/creators/:service/:creatorExternalId/posts', listPublicPosts);
app.get('/api/v1/creators/:service/:creatorExternalId/post/:postExternalId', getPublicPost);
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
