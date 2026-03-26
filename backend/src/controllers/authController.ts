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

      // Create new account
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = await prisma.user.create({
        data: { username: cleanUsername, passwordHash: hash },
      });
      logger.info('New user created', { userId: user.id, username: cleanUsername });

      const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
      res.status(201).json({ token, user: { id: user.id, username: user.username, createdAt: user.createdAt } });
      return;
    }

    // Username exists — validate password
    const valid = existing.passwordHash ? await bcrypt.compare(password, existing.passwordHash) : false;
    if (!valid) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const token = jwt.sign({ sub: existing.id, username: existing.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: existing.id, username: existing.username, createdAt: existing.createdAt } });
  } catch (err) {
    logger.error('login failed', { username: cleanUsername, error: (err as Error).message });
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
      select: { id: true, username: true, createdAt: true },
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
