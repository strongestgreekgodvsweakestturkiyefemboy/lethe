'use client';

import { useEffect, useState, useCallback } from 'react';

const BACKEND_URL = '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DiscordAuthor {
  id: string;
  discordId: string;
  username: string | null;
  globalName: string | null;
  avatarUrl: string | null;
}

interface MessageAttachment {
  id: string;
  fileUrl: string;
  dataType: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';
  name: string | null;
  originalUrl: string | null;
}

interface MessageRevision {
  content: string | null;
  editedAt: string | null;
}

interface DiscordMessage {
  id: string;
  messageId: string;
  content: string | null;
  publishedAt: string | null;
  createdAt: string;
  author: DiscordAuthor | null;
  attachments: MessageAttachment[];
  revisions: MessageRevision[];
  _count: { attachments: number; revisions: number };
}

// ── Presign helpers ────────────────────────────────────────────────────────────

const presignCache = new Map<string, string>();

async function fetchPresignedUrl(key: string): Promise<string> {
  if (presignCache.has(key)) return presignCache.get(key)!;
  if (key.startsWith('http')) return key;
  const res = await fetch(`${BACKEND_URL}/api/v1/files/presign?key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error('Failed to get presigned URL');
  const { url } = (await res.json()) as { url: string };
  presignCache.set(key, url);
  return url;
}

// ── Attachment renderer ────────────────────────────────────────────────────────

function MessageAttachmentView({ att }: { att: MessageAttachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    fetchPresignedUrl(att.fileUrl).then(setUrl).catch(() => setErr(true));
  }, [att.fileUrl]);

  const filename = att.name ?? att.fileUrl.split('/').pop() ?? 'file';

  if (err) return null;
  if (!url) return <div className="h-32 w-48 bg-gray-700 rounded-lg animate-pulse" />;

  if (att.dataType === 'IMAGE') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={filename}
        className="max-w-sm max-h-72 rounded-lg object-cover cursor-pointer hover:opacity-90 transition-opacity"
        onClick={() => window.open(url, '_blank')}
      />
    );
  }
  if (att.dataType === 'VIDEO') {
    return (
      <video
        controls
        preload="metadata"
        className="max-w-sm rounded-lg"
      >
        <source src={url} />
      </video>
    );
  }
  if (att.dataType === 'AUDIO') {
    return (
      <div className="bg-gray-700 rounded-lg p-3 max-w-sm">
        <audio controls className="w-full">
          <source src={url} />
        </audio>
        <p className="text-xs text-gray-400 mt-1 truncate">{filename}</p>
      </div>
    );
  }
  return (
    <a
      href={url}
      download={filename}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 rounded-lg px-3 py-2 text-sm max-w-xs transition-colors"
    >
      <span className="text-lg">📄</span>
      <span className="truncate text-gray-200">{filename}</span>
    </a>
  );
}

// ── Single message bubble ──────────────────────────────────────────────────────

function MessageBubble({ msg, prevMsg }: { msg: DiscordMessage; prevMsg: DiscordMessage | null }) {
  const content = msg.revisions[0]?.content ?? msg.content ?? '';
  const author = msg.author;
  const authorName = author?.globalName ?? author?.username ?? 'Unknown User';
  const ts = msg.publishedAt ? new Date(msg.publishedAt) : new Date(msg.createdAt);

  // Group consecutive messages from the same author within 7 minutes (Discord-style)
  const prevAuthor = prevMsg?.author;
  const prevAuthorName = prevAuthor?.globalName ?? prevAuthor?.username ?? 'Unknown User';
  const prevTs = prevMsg?.publishedAt
    ? new Date(prevMsg.publishedAt)
    : prevMsg
    ? new Date(prevMsg.createdAt)
    : null;
  const isGrouped =
    prevMsg !== null &&
    prevTs !== null &&
    ts.getTime() - prevTs.getTime() < 7 * 60 * 1000 &&
    authorName === prevAuthorName;

  const initial = authorName[0]?.toUpperCase() ?? '#';

  return (
    <div className={`flex items-start gap-3 px-4 group hover:bg-white/5 rounded py-0.5 ${isGrouped ? '' : 'mt-4'}`}>
      {/* Avatar col */}
      <div className="w-10 shrink-0 flex items-start justify-center pt-0.5">
        {isGrouped ? (
          <span className="text-[10px] text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity leading-5 select-none">
            {ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        ) : author?.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={author.avatarUrl}
            alt={authorName}
            className="w-10 h-10 rounded-full object-cover"
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-indigo-700 flex items-center justify-center text-white font-bold text-sm select-none">
            {initial}
          </div>
        )}
      </div>

      {/* Content col */}
      <div className="flex-1 min-w-0">
        {!isGrouped && (
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className="font-semibold text-white text-sm">
              {authorName}
            </span>
            {author?.username && author.globalName && (
              <span className="text-xs text-gray-500">@{author.username}</span>
            )}
            <span className="text-xs text-gray-500">
              {ts.toLocaleDateString()} {ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
            {msg.revisions.length > 1 && (
              <span className="text-[10px] text-gray-600 italic">(edited)</span>
            )}
          </div>
        )}

        {/* Message text */}
        {content && (
          <p className="text-sm text-gray-200 whitespace-pre-wrap break-words leading-relaxed">
            {content}
          </p>
        )}

        {/* Attachments */}
        {(msg.attachments ?? []).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {(msg.attachments ?? []).map((att) => (
              <MessageAttachmentView key={att.id} att={att} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  /** Internal DB id of the DiscordServer record. */
  serverId: string;
  /** Discord channel snowflake (channelId field on DiscordChannel). */
  channelId: string;
  channelName: string | null;
}

export default function DiscordChannelView({ serverId, channelId, channelName }: Props) {
  const [messages, setMessages] = useState<DiscordMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (cursorValue: string | null, replace: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (cursorValue) params.set('before', cursorValue);

        const res = await fetch(
          `${BACKEND_URL}/api/v1/discord/servers/${serverId}/channels/${channelId}/messages?${params.toString()}`,
        );
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        const data = (await res.json()) as {
          messages: DiscordMessage[];
          nextCursor: string | null;
        };

        // Sort oldest-first for chat display (API returns newest-first)
        const sorted = [...data.messages].reverse();

        setMessages((prev) => (replace ? sorted : [...sorted, ...prev]));
        setNextCursor(data.nextCursor);
        setHasMore(data.nextCursor !== null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    },
    [serverId, channelId],
  );

  useEffect(() => {
    setMessages([]);
    setNextCursor(null);
    loadPage(null, true);
  }, [loadPage]);

  return (
    <div className="flex flex-col h-full bg-gray-950">
      {/* Channel header */}
      <div className="shrink-0 h-12 flex items-center gap-2 px-4 border-b border-gray-800 bg-gray-900">
        <span className="text-gray-400 font-bold text-lg">#</span>
        <span className="font-semibold text-white truncate">
          {channelName ?? channelId}
        </span>
        <span className="text-xs text-gray-500 ml-2">Discord · channel {channelId}</span>
      </div>

      {/* Messages list */}
      <div className="flex-1 overflow-y-auto py-4 space-y-0">
        {hasMore && !loading && (
          <div className="flex justify-center pb-4">
            <button
              onClick={() => loadPage(nextCursor, false)}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Load older messages
            </button>
          </div>
        )}

        {loading && messages.length === 0 && (
          <div className="flex items-center justify-center py-12 text-gray-500 text-sm">
            Loading messages…
          </div>
        )}

        {!loading && messages.length === 0 && !error && (
          <div className="flex items-center justify-center py-12 text-gray-500 text-sm">
            No messages archived in this channel.
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center py-12 text-red-400 text-sm">
            {error}
          </div>
        )}

        {messages.map((msg, idx) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            prevMsg={idx > 0 ? messages[idx - 1] : null}
          />
        ))}

        {loading && messages.length > 0 && (
          <p className="text-center text-gray-500 text-xs py-2">Loading…</p>
        )}
      </div>
    </div>
  );
}
