'use client';

import { useEffect, useState } from 'react';
import DiscordChannelView from './DiscordChannelView';
import TagsSection from './TagsSection';
import { useAuth } from './AuthContext';

const BACKEND_URL = '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DiscordRole {
  id: string;
  roleId: string;
  name: string;
  color: number;
  position: number;
}

interface DiscordChannel {
  id: string;
  channelId: string;
  name: string;
  type: number;
  parentId: string | null;
  position: number;
  isVisible: boolean;
  creatorId: string | null;
  _count: { messages: number };
}

interface DiscordServer {
  id: string;
  guildId: string;
  name: string;
  iconUrl: string | null;
  roles: DiscordRole[];
  channels: DiscordChannel[];
  userTags: { tag: { id: string; name: string }; addedByMe: boolean }[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Convert a Discord colour integer to a CSS hex string, or undefined for no colour. */
function roleColor(color: number): string | undefined {
  if (!color) return undefined;
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Channel type constants */
const CH_TEXT = 0;
const CH_VOICE = 2;
const CH_CATEGORY = 4;
const CH_ANNOUNCEMENT = 5;

const IMPORTABLE_TYPES = new Set([CH_TEXT, CH_ANNOUNCEMENT]);

// ── Channel icon ───────────────────────────────────────────────────────────────

function ChannelIcon({ type }: { type: number }) {
  if (type === CH_VOICE) {
    return (
      <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h2v-8H5v-1a7 7 0 0 1 14 0v1h-2v8h2a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9Z" />
      </svg>
    );
  }
  if (type === CH_ANNOUNCEMENT) {
    return (
      <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3 6a1 1 0 0 1 1-1h10a1 1 0 0 1 0 2H4a1 1 0 0 1-1-1ZM3 12a1 1 0 0 1 1-1h10a1 1 0 0 1 0 2H4a1 1 0 0 1-1-1ZM3 18a1 1 0 0 1 1-1h6a1 1 0 0 1 0 2H4a1 1 0 0 1-1-1ZM20 5a1 1 0 0 0-2 0v6l-1.293-1.293a1 1 0 0 0-1.414 1.414L18 14l2.707-2.879A1 1 0 0 0 20 11V5Z" />
      </svg>
    );
  }
  // Default text channel — # icon
  return (
    <span className="text-base font-semibold leading-none select-none">#</span>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

interface SidebarProps {
  server: DiscordServer;
  activeChannel: DiscordChannel | null;
  onSelectChannel: (channel: DiscordChannel) => void;
}

function ServerSidebar({ server, activeChannel, onSelectChannel }: SidebarProps) {
  // Build a map of categoryId → child channels
  const categories = server.channels.filter((c) => c.type === CH_CATEGORY);
  const childMap = new Map<string | null, DiscordChannel[]>();

  for (const ch of server.channels) {
    if (ch.type === CH_CATEGORY) continue;
    const parent = ch.parentId ?? null;
    if (!childMap.has(parent)) childMap.set(parent, []);
    childMap.get(parent)!.push(ch);
  }

  // Sort children by position
  for (const [, children] of childMap) {
    children.sort((a, b) => a.position - b.position);
  }

  const sortedCategories = [...categories].sort((a, b) => a.position - b.position);

  function renderChannel(ch: DiscordChannel) {
    const isActive = activeChannel?.channelId === ch.channelId;
    // Channel is clickable if it has archived messages in the new model OR has a legacy creatorId
    const hasMessages = ch._count.messages > 0 || ch.creatorId !== null;
    const isClickable = hasMessages && IMPORTABLE_TYPES.has(ch.type);

    return (
      <button
        key={ch.id}
        onClick={() => isClickable && onSelectChannel(ch)}
        disabled={!isClickable}
        className={[
          'w-full flex items-center gap-1.5 px-2 py-0.5 rounded text-sm transition-colors text-left',
          isActive
            ? 'user-sidebar-active'
            : isClickable
            ? 'hover:user-sidebar-active cursor-pointer opacity-60 hover:opacity-100'
            : 'cursor-default opacity-30',
        ].join(' ')}
        title={!hasMessages ? 'Channel not archived' : undefined}
      >
        <span className="text-gray-500">
          <ChannelIcon type={ch.type} />
        </span>
        <span className="truncate">{ch.name}</span>
        {ch._count.messages > 0 && (
          <span className="ml-auto text-[10px] text-gray-600 shrink-0">
            {ch._count.messages}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="flex flex-col w-60 shrink-0 user-sidebar-bg overflow-y-auto">
      {/* Server name header */}
      <div className="h-12 flex items-center px-4 border-b font-semibold shrink-0 truncate" style={{ borderColor: 'var(--user-border-color)', color: 'var(--user-font-color)' }}>
        {server.iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={server.iconUrl} alt={server.name} className="w-6 h-6 rounded-full mr-2 shrink-0" />
        ) : (
          <div className="w-6 h-6 rounded-full user-btn flex items-center justify-center text-xs font-bold mr-2 shrink-0">
            {server.name[0]?.toUpperCase() ?? 'S'}
          </div>
        )}
        <span className="truncate">{server.name}</span>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto py-2 space-y-0.5 px-2">
        {/* Uncategorised channels (parentId = null) */}
        {(childMap.get(null) ?? []).map(renderChannel)}

        {/* Categories + their children */}
        {sortedCategories.map((cat) => (
          <div key={cat.id} className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 px-2 pb-1 truncate">
              {cat.name}
            </p>
            {(childMap.get(cat.channelId) ?? []).map(renderChannel)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Welcome screen ─────────────────────────────────────────────────────────────

function WelcomeScreen({ serverName }: { serverName: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center user-bg text-center select-none" style={{ opacity: 0.6 }}>
      <div className="w-20 h-20 rounded-full user-sidebar-bg flex items-center justify-center text-4xl mb-6">
        #
      </div>
      <h2 className="text-white text-2xl font-bold mb-2">Welcome to {serverName}!</h2>
      <p className="text-sm">Select an archived channel from the sidebar to start browsing.</p>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  serverId: string;
  /** Discord channel snowflake to pre-select on load. */
  activeChannelId?: string;
}

export default function DiscordServerView({ serverId, activeChannelId }: Props) {
  const { token } = useAuth();
  const [server, setServer] = useState<DiscordServer | null>(null);
  const [activeChannel, setActiveChannel] = useState<DiscordChannel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    fetch(`${BACKEND_URL}/api/v1/discord/servers/${serverId}`, { headers })
      .then((r) => {
        if (!r.ok) throw new Error(`Server error: ${r.status}`);
        return r.json() as Promise<{ server: DiscordServer }>;
      })
      .then(({ server }) => {
        setServer(server);
        // If an activeChannelId snowflake was provided, try to pre-select it;
        // otherwise fall back to the first archived text/announcement channel.
        const target = activeChannelId
          ? server.channels.find((c) => c.channelId === activeChannelId)
          : undefined;
        const first =
          target ??
          server.channels.find(
            (c) => (c._count.messages > 0 || c.creatorId !== null) && IMPORTABLE_TYPES.has(c.type),
          );
        if (first) setActiveChannel(first);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, [serverId, activeChannelId, token]);

  if (loading) {
    return (
      <div className="flex h-full user-bg items-center justify-center text-sm" style={{ opacity: 0.5 }}>
        Loading server…
      </div>
    );
  }

  if (error || !server) {
    return (
      <div className="flex h-full user-bg items-center justify-center text-red-400 text-sm">
        {error ?? 'Discord server not found.'}
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex flex-col w-60 shrink-0 overflow-hidden">
        <ServerSidebar
          server={server}
          activeChannel={activeChannel}
          onSelectChannel={setActiveChannel}
        />
        {/* Server tags in the sidebar footer */}
        <div className="shrink-0 border-t px-3 py-3 user-sidebar-bg" style={{ borderColor: 'var(--user-border-color)' }}>
          <TagsSection
            entityType="discordServer"
            entityId={server.id}
            initialUserTags={server.userTags}
          />
        </div>
      </div>

      <div className="flex-1 min-w-0 flex flex-col">
        {activeChannel ? (
          <DiscordChannelView
            serverId={serverId}
            channelId={activeChannel.channelId}
            channelName={activeChannel.name}
          />
        ) : (
          <WelcomeScreen serverName={server.name} />
        )}
      </div>
    </div>
  );
}
