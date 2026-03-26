'use client';

import { useEffect, useState, useCallback } from 'react';

const BACKEND_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001')
    : 'http://localhost:3001';

interface DataItem {
  id: string;
  userId: string;
  sourceSite: string;
  dataType: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';
  content: string | null;
  fileUrl: string | null;
  sourcePostId: string | null;
  publishedAt: string | null;
  createdAt: string;
}

interface Props {
  sourceSite?: string;
  dataType?: string;
}

// Cache of presigned URLs so we don't re-request them on every render.
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

function TextCard({ item }: { item: DataItem }) {
  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-2">
      <span className="text-xs font-semibold uppercase text-gray-500">{item.sourceSite} · text</span>
      <p className="text-sm text-gray-200 whitespace-pre-wrap line-clamp-6">{item.content}</p>
      <p className="text-xs text-gray-600">{new Date(item.createdAt).toLocaleString()}</p>
    </div>
  );
}

function MediaCard({ item }: { item: DataItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!item.fileUrl) return;
    fetchPresignedUrl(item.fileUrl)
      .then(setUrl)
      .catch(() => setError(true));
  }, [item.fileUrl]);

  const label = `${item.sourceSite} · ${item.dataType.toLowerCase()}`;

  if (error) {
    return (
      <div className="bg-gray-800 rounded-xl p-4 flex items-center justify-center text-gray-500 text-sm aspect-square">
        Media unavailable
      </div>
    );
  }

  if (!url) {
    return (
      <div className="bg-gray-800 rounded-xl p-4 flex items-center justify-center text-gray-600 text-sm aspect-square animate-pulse">
        Loading…
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-xl overflow-hidden space-y-1">
      {item.dataType === 'IMAGE' && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={item.fileUrl ?? 'image'} className="w-full object-cover" />
      )}
      {item.dataType === 'VIDEO' && (
        <video controls className="w-full" preload="metadata">
          <source src={url} />
          Your browser does not support video playback.
        </video>
      )}
      {item.dataType === 'AUDIO' && (
        <div className="p-4">
          <audio controls className="w-full">
            <source src={url} />
            Your browser does not support audio playback.
          </audio>
        </div>
      )}
      <div className="px-3 pb-3">
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-xs text-gray-700">{new Date(item.createdAt).toLocaleString()}</p>
      </div>
    </div>
  );
}

function FileCard({ item }: { item: DataItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!item.fileUrl) return;
    fetchPresignedUrl(item.fileUrl)
      .then(setUrl)
      .catch(() => setError(true));
  }, [item.fileUrl]);

  const filename = item.fileUrl?.split('/').pop() ?? 'file';

  return (
    <div className="bg-gray-800 rounded-xl p-4 flex items-center gap-3">
      <span className="text-2xl">📄</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-200 truncate">{filename}</p>
        <p className="text-xs text-gray-500">{item.sourceSite} · file</p>
        <p className="text-xs text-gray-700">{new Date(item.createdAt).toLocaleString()}</p>
      </div>
      {!error && url && (
        <a
          href={url}
          download={filename}
          className="shrink-0 bg-indigo-700 hover:bg-indigo-600 text-white text-xs font-medium rounded-lg px-3 py-1.5 transition-colors"
        >
          Download
        </a>
      )}
      {error && <span className="text-xs text-red-400">Unavailable</span>}
      {!error && !url && <span className="text-xs text-gray-500">Loading…</span>}
    </div>
  );
}


export default function ItemsGallery({ sourceSite, dataType }: Props) {
  const [items, setItems] = useState<DataItem[]>([]);
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
        if (dataType) params.set('dataType', dataType);
        if (cursorValue) params.set('cursor', cursorValue);

        const res = await fetch(`${BACKEND_URL}/api/v1/items?${params.toString()}`);
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        const data = (await res.json()) as { items: DataItem[]; nextCursor: string | null };

        setItems((prev) => (replace ? data.items : [...prev, ...data.items]));
        setCursor(data.nextCursor);
        setHasMore(data.nextCursor !== null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    },
    [sourceSite, dataType],
  );

  // Initial load / reload when filters change
  useEffect(() => {
    setItems([]);
    setCursor(null);
    loadPage(null, true);
  }, [loadPage]);

  if (error) {
    return <p className="text-red-400 text-sm">{error}</p>;
  }

  if (!loading && items.length === 0) {
    return (
      <p className="text-gray-500 text-sm text-center py-12">
        No items found. Start an import to see results here.
      </p>
    );
  }

  const textItems = items.filter((i) => i.dataType === 'TEXT');
  const mediaItems = items.filter((i) => i.dataType === 'IMAGE' || i.dataType === 'VIDEO' || i.dataType === 'AUDIO');
  const fileItems = items.filter((i) => i.dataType === 'FILE');

  return (
    <div className="space-y-8">
      {mediaItems.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-4 text-gray-300">Media</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {mediaItems.map((item) => (
              <MediaCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      )}

      {fileItems.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-4 text-gray-300">Files</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {fileItems.map((item) => (
              <FileCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      )}

      {textItems.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-4 text-gray-300">Posts</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {textItems.map((item) => (
              <TextCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      )}

      {loading && (
        <p className="text-center text-gray-500 text-sm py-4">Loading…</p>
      )}

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
