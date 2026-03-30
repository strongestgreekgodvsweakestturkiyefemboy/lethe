import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger';

const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET ?? 'lethe-dev-secret-change-in-production';
const BCRYPT_ROUNDS = 10;

/**
 * POST /api/v1/auth/login
 *
 * Body: { username, password }
 *
 * If the username does not exist yet, respond with { exists: false } so the
 * client can ask the user to confirm account creation.
 *
 * If body includes { create: true } alongside the credentials, create the
 * account and return a JWT.
 *
 * If the username exists, validate the password and return a JWT on success.
 */
export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { username, password, create } = req.body as {
    username?: string;
    password?: string;
    create?: boolean;
  };

  if (!username?.trim() || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }

  const cleanUsername = username.trim().toLowerCase();
  if (!/^[a-z0-9_\-.]{1,32}$/.test(cleanUsername)) {
    res.status(400).json({ error: 'Username must be 1–32 characters: letters, digits, underscores, hyphens, or dots' });
    return;
  }

  try {
    const existing = await prisma.user.findUnique({ where: { username: cleanUsername } });

    if (!existing) {
      // Username not found — ask the client whether to create
      if (!create) {
        res.json({ exists: false });
        return;
      }

      // First ever account becomes admin automatically.
      // userCount <= 1 accounts for the 'default' placeholder user that gets
      // created as import-job owner when no userId is supplied.
      const userCount = await prisma.user.count();
      const isFirstUser = userCount <= 1;

      // Create new account
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = await prisma.user.create({
        data: { username: cleanUsername, passwordHash: hash, isAdmin: isFirstUser },
      });
      logger.info('New user created', { userId: user.id, username: cleanUsername, isAdmin: isFirstUser });

      const token = jwt.sign({ sub: user.id, username: user.username, isAdmin: user.isAdmin }, JWT_SECRET, { expiresIn: '30d' });
      res.status(201).json({ token, user: { id: user.id, username: user.username, isAdmin: user.isAdmin, createdAt: user.createdAt } });
      return;
    }

    // Username exists — validate password
    const valid = existing.passwordHash ? await bcrypt.compare(password, existing.passwordHash) : false;
    if (!valid) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const token = jwt.sign({ sub: existing.id, username: existing.username, isAdmin: existing.isAdmin }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: existing.id, username: existing.username, isAdmin: existing.isAdmin, createdAt: existing.createdAt } });
  } catch (err) {
    logger.error('login failed', { username: cleanUsername, error: (err as Error).message });
    next(err);
  }
}

/**
 * PATCH /api/v1/auth/password
 *
 * Change the current user's password.
 * Requires a valid Bearer JWT.
 * Body: { currentPassword: string; newPassword: string }
 */
export async function changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  let userId: string;
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { sub: string };
    userId = payload.sub;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const { currentPassword, newPassword } = req.body as {
    currentPassword?: string;
    newPassword?: string;
  };

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: 'currentPassword and newPassword are required' });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({ error: 'New password must be at least 8 characters' });
    return;
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const valid = user.passwordHash ? await bcrypt.compare(currentPassword, user.passwordHash) : false;
    if (!valid) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } });
    logger.info('Password changed', { userId });
    res.json({ ok: true });
  } catch (err) {
    logger.error('changePassword failed', { userId, error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/v1/auth/me
 *
 * Returns the current user from the JWT in the Authorization header.
 */
export async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { sub: string; username: string };
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, username: true, isAdmin: true, createdAt: true },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
