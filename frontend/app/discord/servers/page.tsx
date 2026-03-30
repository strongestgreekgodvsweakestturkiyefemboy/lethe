'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const BACKEND_URL = '';

interface DiscordServer {
  id: string;
  guildId: string;
  name: string;
  iconUrl: string | null;
  createdAt: string;
  _count: { channels: number };
}

export default function DiscordServersPage() {
  const [servers, setServers] = useState<DiscordServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/v1/discord/servers`)
      .then((r) => {
        if (!r.ok) throw new Error(`Server error: ${r.status}`);
        return r.json() as Promise<{ servers: DiscordServer[] }>;
      })
      .then(({ servers }) => setServers(servers))
      .catch((err) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-[calc(100vh-3rem)] user-bg">
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Discord Servers</h1>
          <Link
            href="/import"
            className="text-sm user-btn transition-colors px-4 py-2 rounded-lg font-medium"
          >
            + Import Discord
          </Link>
        </div>

        {loading && (
          <div className="text-center text-gray-500 py-16">Loading servers…</div>
        )}

        {error && (
          <div className="text-center text-red-400 py-16">{error}</div>
        )}

        {!loading && !error && servers.length === 0 && (
          <div className="text-center text-gray-500 py-16 space-y-3">
            <p>No Discord servers imported yet.</p>
            <Link
              href="/import"
              className="text-indigo-400 hover:text-indigo-300 text-sm"
            >
              Start a Discord import →
            </Link>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {servers.map((srv) => (
            <Link
              key={srv.id}
              href={`/discord/servers/${srv.id}`}
              className="flex items-center gap-4 user-card rounded-xl p-4"
            >
              {srv.iconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={srv.iconUrl}
                  alt={srv.name}
                  className="w-12 h-12 rounded-xl shrink-0 object-cover"
                />
              ) : (
                <div className="w-12 h-12 rounded-xl user-btn flex items-center justify-center text-white font-bold text-xl shrink-0">
                  {srv.name[0]?.toUpperCase() ?? 'S'}
                </div>
              )}
              <div className="min-w-0">
                <p className="font-semibold text-white truncate">{srv.name}</p>
                <p className="text-xs text-gray-400">
                  {srv._count.channels} channel{srv._count.channels !== 1 ? 's' : ''}
                </p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
