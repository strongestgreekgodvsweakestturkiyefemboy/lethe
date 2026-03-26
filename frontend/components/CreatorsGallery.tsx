'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

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

interface Props {
  sourceSite?: string;
  serviceType?: string;
}

const presignCache = new Map<string, string>();

async function fetchPresignedUrl(
  key: string,
  backendUrl: string,
): Promise<string> {
  if (presignCache.has(key)) return presignCache.get(key)!;
  // External URLs (start with http) don't need presigning
  if (key.startsWith('http')) return key;
  const res = await fetch(`${backendUrl}/api/v1/files/presign?key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error('Failed to get presigned URL');
  const { url } = (await res.json()) as { url: string };
  presignCache.set(key, url);
  return url;
}

function CreatorCard({ creator }: { creator: Creator }) {
  const displayName = creator.name ?? creator.externalId;
  const initial = displayName[0]?.toUpperCase() ?? '?';
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!creator.thumbnailUrl) return;
    fetchPresignedUrl(creator.thumbnailUrl, BACKEND_URL)
      .then(setThumbUrl)
      .catch(() => setThumbUrl(null));
  }, [creator.thumbnailUrl]);

  return (
    <Link
      href={`/${creator.serviceType}/user/${creator.externalId}`}
      className="bg-gray-800 rounded-xl p-4 hover:bg-gray-700 transition-colors flex items-start gap-3"
    >
      {/* Avatar */}
      {thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbUrl}
          alt={displayName}
          className="w-12 h-12 rounded-full object-cover shrink-0"
        />
      ) : (
        <div className="w-12 h-12 rounded-full bg-gray-600 shrink-0 flex items-center justify-center text-gray-300 font-semibold text-lg">
          {initial}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="font-semibold text-white truncate">{displayName}</p>
          <div className="shrink-0 text-right">
            <span className="text-sm font-semibold text-indigo-400">{creator._count.posts}</span>
            <p className="text-xs text-gray-500">posts</p>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-0.5">
          {creator.serviceType} · {creator.sourceSite}
        </p>
        <p className="text-xs text-gray-600 mt-1">
          {new Date(creator.createdAt).toLocaleDateString()}
        </p>
      </div>
    </Link>
  );
}

export default function CreatorsGallery({ sourceSite, serviceType }: Props) {
  const [creators, setCreators] = useState<Creator[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (cursorValue: string | null, replace: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (sourceSite) params.set('sourceSite', sourceSite);
        if (serviceType) params.set('serviceType', serviceType);
        if (cursorValue) params.set('cursor', cursorValue);

        const res = await fetch(`${BACKEND_URL}/api/v1/creators?${params.toString()}`);
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        const data = (await res.json()) as { creators: Creator[]; nextCursor: string | null };

        setCreators((prev) => (replace ? data.creators : [...prev, ...data.creators]));
        setCursor(data.nextCursor);
        setHasMore(data.nextCursor !== null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    },
    [sourceSite, serviceType],
  );

  useEffect(() => {
    setCreators([]);
    setCursor(null);
    loadPage(null, true);
  }, [loadPage]);

  if (error) {
    return <p className="text-red-400 text-sm">{error}</p>;
  }

  if (!loading && creators.length === 0) {
    return (
      <p className="text-gray-500 text-sm text-center py-12">
        No creators found. Import from Kemono to see creators here.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {creators.map((creator) => (
          <CreatorCard key={creator.id} creator={creator} />
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
  );
}
