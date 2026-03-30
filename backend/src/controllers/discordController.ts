import { Request, Response } from 'express';
import logger from '../utils/logger';

const DISCORD_API = 'https://discord.com/api/v10';

interface DiscordChannelRecord {
  type: number;
  id: string;
  name: string;
  position: number;
}

const DISCORD_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

interface DiscordTokenBody {
  token: string;
}

function discordHeaders(token: string): Record<string, string> {
  return {
    Authorization: token.trim(),
    'Accept': 'application/json',
    'User-Agent': DISCORD_UA,
  };
}

/**
 * POST /api/v1/discord/guilds
 *
 * Proxies GET /users/@me/guilds to return the list of guilds the token can
 * access.  The token is used only for this request and is never persisted.
 */
export async function getDiscordGuilds(req: Request, res: Response): Promise<void> {
  const { token } = req.body as DiscordTokenBody;

  if (!token || typeof token !== 'string' || !token.trim()) {
    res.status(400).json({ error: 'token is required' });
    return;
  }

  try {
    const discordRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: discordHeaders(token),
    });

    if (discordRes.status === 401) {
      res.status(401).json({ error: 'Invalid Discord token — please check your credentials.' });
      return;
    }

    if (discordRes.status === 429) {
      res.status(429).json({ error: 'Discord is rate-limiting this request. Please wait a moment and try again.' });
      return;
    }

    if (!discordRes.ok) {
      logger.warn('Discord guilds API returned non-OK', { status: discordRes.status });
      res.status(discordRes.status).json({ error: `Discord API returned ${discordRes.status}` });
      return;
    }

    const guilds = await discordRes.json() as unknown[];
    res.json({ guilds });
  } catch (err) {
    logger.error('getDiscordGuilds failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to contact Discord API' });
  }
}

/**
 * POST /api/v1/discord/guilds/:guildId/channels
 *
 * Proxies GET /guilds/:guildId/channels, returning only text (type 0) and
 * announcement (type 5) channels.  The token is used only for this request
 * and is never persisted.
 */
export async function getDiscordGuildChannels(req: Request, res: Response): Promise<void> {
  const { guildId } = req.params;
  const { token } = req.body as DiscordTokenBody;

  if (!token || typeof token !== 'string' || !token.trim()) {
    res.status(400).json({ error: 'token is required' });
    return;
  }

  if (!/^\d+$/.test(guildId)) {
    res.status(400).json({ error: 'guildId must be a numeric Discord snowflake' });
    return;
  }

  try {
    const discordRes = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
      headers: discordHeaders(token),
    });

    if (discordRes.status === 401) {
      res.status(401).json({ error: 'Invalid Discord token — please check your credentials.' });
      return;
    }

    if (discordRes.status === 403) {
      res.status(403).json({ error: 'Missing permissions to read this guild\'s channels.' });
      return;
    }

    if (discordRes.status === 404) {
      res.status(404).json({ error: 'Guild not found. Check the guild ID.' });
      return;
    }

    if (discordRes.status === 429) {
      res.status(429).json({ error: 'Discord is rate-limiting this request. Please wait a moment and try again.' });
      return;
    }

    if (!discordRes.ok) {
      logger.warn('Discord channels API returned non-OK', { status: discordRes.status, guildId });
      res.status(discordRes.status).json({ error: `Discord API returned ${discordRes.status}` });
      return;
    }

    const allChannels = await discordRes.json() as DiscordChannelRecord[];
    // Return only text (0) and announcement (5) channels, sorted by position
    const channels = allChannels
      .filter((c) => c.type === 0 || c.type === 5)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    res.json({ channels });
  } catch (err) {
    logger.error('getDiscordGuildChannels failed', { guildId, error: (err as Error).message });
    res.status(500).json({ error: 'Failed to contact Discord API' });
  }
}
