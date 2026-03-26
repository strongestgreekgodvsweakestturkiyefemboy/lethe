'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import DiscordChannelView from '@/components/DiscordChannelView';
import FavoriteButton from '@/components/FavoriteButton';

const BACKEND_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001')
    : 'http://localhost:3001';

interface Creator {
  id: string;
  userId: string;
  sourceSite: string;
  serviceType: string;
  externalId: string;
  name: string | null;
  thumbnailUrl: string | null;
  bannerUrl: string | null;
  createdAt: string;
  _count: { posts: number };
}

interface PostRevisionSummary {
  title: string | null;
  content: string | null;
}

interface PostListItem {
  id: string;
  externalId: string;
  publishedAt: string | null;
  createdAt: string;
  revisions: PostRevisionSummary[];
  _count: { attachments: number; comments: number; revisions: number };
  creator: { serviceType: string; externalId: string };
}

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

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function CreatorHeader({ creator, displayName }: { creator: Creator; displayName: string }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [bannerSrc, setBannerSrc] = useState<string | null>(null);
  const initial = displayName[0]?.toUpperCase() ?? '?';

  useEffect(() => {
    if (creator.thumbnailUrl) {
      fetchPresignedUrl(creator.thumbnailUrl).then(setThumbUrl).catch(() => setThumbUrl(null));
    }
    if (creator.bannerUrl) {
      fetchPresignedUrl(creator.bannerUrl).then(setBannerSrc).catch(() => setBannerSrc(null));
    }
  }, [creator.thumbnailUrl, creator.bannerUrl]);

  return (
    <div className="rounded-xl overflow-hidden bg-gray-800">
      {/* Banner */}
      <div className="h-36 bg-gradient-to-br from-gray-700 to-gray-900 relative overflow-hidden">
        {bannerSrc && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={bannerSrc} alt="banner" className="w-full h-full object-cover" />
        )}
      </div>
      {/* Avatar + info */}
      <div className="flex items-end gap-4 px-5 pb-5 -mt-10 relative">
        <div className="shrink-0">
          {thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbUrl}
              alt={displayName}
              className="w-20 h-20 rounded-xl object-cover border-4 border-gray-800"
            />
          ) : (
            <div className="w-20 h-20 rounded-xl bg-gray-600 border-4 border-gray-800 flex items-center justify-center text-gray-300 font-bold text-2xl">
              {initial}
            </div>
          )}
        </div>
        <div className="pb-1 flex-1">
          <h1 className="text-xl font-bold text-white">{displayName}</h1>
          <p className="text-sm text-gray-400">
            {creator.serviceType} · {creator.sourceSite} · {creator._count.posts} posts
          </p>
        </div>
        <div className="pb-1 ml-auto">
          <FavoriteButton creatorId={creator.id} />
        </div>
      </div>
    </div>
  );
}

function PostCard({
  post,
  serviceType,
  creatorExternalId,
}: {
  post: PostListItem;
  serviceType: string;
  creatorExternalId: string;
}) {
  const latest = post.revisions[0];
  const title = latest?.title ?? '(untitled)';
  const rawContent = latest?.content ?? '';
  const preview = rawContent ? stripHtml(rawContent).slice(0, 200) : '';

  return (
    <Link
      href={`/${serviceType}/user/${creatorExternalId}/post/${post.externalId}`}
      className="bg-gray-800 rounded-xl p-4 hover:bg-gray-700 transition-colors space-y-2 block"
    >
      <p className="font-semibold text-white line-clamp-2">{title}</p>
      {preview && <p className="text-sm text-gray-400 line-clamp-3">{preview}</p>}
      <div className="flex items-center gap-4 text-xs text-gray-500 pt-1">
        {post.publishedAt && (
          <span>{new Date(post.publishedAt).toLocaleDateString()}</span>
        )}
        {post._count.attachments > 0 && <span>📎 {post._count.attachments}</span>}
        {post._count.comments > 0 && <span>💬 {post._count.comments}</span>}
        {post._count.revisions > 1 && <span>🔄 {post._count.revisions} revisions</span>}
      </div>
    </Link>
  );
}

export default function CreatorSemanticPage() {
  const { service, creatorId } = useParams<{ service: string; creatorId: string }>();
  const [creator, setCreator] = useState<Creator | null>(null);
  const [posts, setPosts] = useState<PostListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPage = async (cursorValue: string | null, replace: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (cursorValue) params.set('cursor', cursorValue);

      const res = await fetch(
        `${BACKEND_URL}/api/v1/${service}/user/${creatorId}?${params.toString()}`,
      );
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = (await res.json()) as {
        creator: Creator;
        posts: PostListItem[];
        nextCursor: string | null;
      };

      if (replace) setCreator(data.creator);
      setPosts((prev) => (replace ? data.posts : [...prev, ...data.posts]));
      setCursor(data.nextCursor);
      setHasMore(data.nextCursor !== null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPage(null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, creatorId]);

  const displayName = creator?.name ?? creatorId;

  // Discord channels get a chat-style view instead of the post grid
  if (service === 'discord' && (creator || !loading)) {
    return (
      <div className="flex flex-col" style={{ height: 'calc(100vh - 3rem)' }}>
        {creator && (
          <div className="shrink-0 px-4 pt-4 pb-2 bg-gray-950">
            <CreatorHeader creator={creator} displayName={displayName} />
          </div>
        )}
        <div className="flex-1 min-h-0">
          <DiscordChannelView
            creatorId={creator?.id ?? ''}
            channelId={creatorId}
            channelName={creator?.name ?? null}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-3rem)] bg-gray-950 text-white">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {creator ? (
          <CreatorHeader creator={creator} displayName={displayName} />
        ) : (
          <div className="h-44 bg-gray-800 rounded-xl animate-pulse" />
        )}

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-gray-200">Posts</h2>
          {!loading && posts.length === 0 && !error && (
            <p className="text-gray-500 text-sm text-center py-12">
              No posts found for this creator.
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {posts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                serviceType={service}
                creatorExternalId={creatorId}
              />
            ))}
          </div>

          {loading && <p className="text-center text-gray-500 text-sm py-4">Loading…</p>}

          {hasMore && !loading && (
            <div className="flex justify-center">
              <button
                onClick={() => loadPage(cursor, false)}
                className="bg-gray-700 hover:bg-gray-600 rounded-lg px-6 py-2 text-sm font-medium transition-colors"
              >
                Load more
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
