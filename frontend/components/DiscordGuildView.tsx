'use client';

import { useEffect, useState } from 'react';
import DiscordServerView from './DiscordServerView';

const BACKEND_URL = '';

interface DiscordServerSummary {
  id: string;
  guildId: string;
  name: string;
}

interface Props {
  /** Discord guild snowflake (guildId). */
  guildId: string;
  /** Discord channel snowflake to pre-select on load. */
  activeChannelId?: string;
}

/**
 * Resolves a Discord guild snowflake to the internal DiscordServer record id,
 * then delegates rendering to DiscordServerView.
 *
 * This powers the /discord/[guildId] and /discord/[guildId]/[channelId] routes
 * which use the public guild snowflake in the URL rather than the internal DB id.
 */
export default function DiscordGuildView({ guildId, activeChannelId }: Props) {
  const [serverId, setServerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`${BACKEND_URL}/api/v1/discord/servers`)
      .then((r) => {
        if (!r.ok) throw new Error(`Server error: ${r.status}`);
        return r.json() as Promise<{ servers: DiscordServerSummary[] }>;
      })
      .then(({ servers }) => {
        const match = servers.find((s) => s.guildId === guildId);
        if (!match) {
          setError(`No archived guild found for ID ${guildId}.`);
        } else {
          setServerId(match.id);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, [guildId]);

  if (loading) {
    return (
      <div className="flex h-full bg-gray-950 items-center justify-center text-gray-500 text-sm">
        Loading guild…
      </div>
    );
  }

  if (error || !serverId) {
    return (
      <div className="flex h-full bg-gray-950 items-center justify-center text-red-400 text-sm">
        {error ?? 'Discord guild not found.'}
      </div>
    );
  }

  return <DiscordServerView serverId={serverId} activeChannelId={activeChannelId} />;
}
