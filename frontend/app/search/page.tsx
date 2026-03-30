'use client';

import { useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';

const BACKEND = '';

interface SearchPost {
  id: string;
  publishedAt: string | null;
  createdAt: string;
  creator: { id: string; name: string | null; serviceType: string; externalId: string };
  revisions: { title: string | null; content: string | null }[];
  _count: { attachments: number; comments: number };
}

function stripHtml(html: string) {
  return html.replace(/<[^>]*>/g, '').slice(0, 150);
}

function SearchInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialQ = searchParams.get('q') ?? '';

  const [q, setQ] = useState(initialQ);
  const [posts, setPosts] = useState<SearchPost[]>([]);
  const [nextPostsCursor, setNextPostsCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const doSearch = useCallback(async (query: string, cursor?: string) => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const url = new URL(`${BACKEND}/api/v1/search/posts`, window.location.origin);
      url.searchParams.set('q', query.trim());
      url.searchParams.set('limit', '20');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url.toString());
      const data = await res.json() as { posts: SearchPost[]; nextCursor: string | null };
      setPosts((p) => cursor ? [...p, ...data.posts] : data.posts);
      setNextPostsCursor(data.nextCursor);
    } finally {
      setLoading(false);
      setSearched(true);
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setPosts([]);
    setNextPostsCursor(null);
    setSearched(false);
    router.replace(`/search?q=${encodeURIComponent(q.trim())}`);
    doSearch(q.trim());
  };

  return (
    <main className="min-h-[calc(100vh-3rem)] user-bg p-6">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Search Posts</h1>

        <form onSubmit={handleSubmit} className="flex gap-2 mb-6">
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search posts…"
            className="flex-1 user-input border rounded-lg px-4 py-2 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!q.trim() || loading}
            className="user-btn disabled:opacity-50 px-5 py-2 rounded-lg font-medium"
          >
            Search
          </button>
        </form>

        {loading && <p className="text-gray-500 text-sm">Searching…</p>}

        {!loading && searched && (
          <>
            {posts.length === 0 ? (
              <p className="text-gray-400">No posts found for &ldquo;{q}&rdquo;.</p>
            ) : (
              <div className="space-y-3">
                {posts.map((post) => {
                  const rev = post.revisions[0];
                  const title = rev?.title ?? 'Untitled';
                  const preview = rev?.content ? stripHtml(rev.content) : '';
                  const creatorHref = `/${post.creator.serviceType}/user/${post.creator.externalId}`;
                  const postHref = `/posts/${post.id}`;
                  return (
                    <div key={post.id} className="user-section-bg rounded-xl p-4">
                      <Link href={creatorHref} className="text-xs text-indigo-400 hover:text-indigo-300">
                        {post.creator.name ?? post.creator.externalId}
                      </Link>
                      <Link href={postHref} className="block font-medium text-white hover:text-indigo-200">{title}</Link>
                      {preview && <p className="text-sm text-gray-400 mt-1 line-clamp-2">{preview}</p>}
                      <p className="text-xs text-gray-600 mt-1">
                        {new Date(post.publishedAt ?? post.createdAt).toLocaleDateString()}
                        {' · '}{post._count.attachments} attachment{post._count.attachments !== 1 ? 's' : ''}
                        {' · '}{post._count.comments} comment{post._count.comments !== 1 ? 's' : ''}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
            {nextPostsCursor && !loading && (
              <div className="text-center mt-4">
                <button
                  onClick={() => doSearch(q.trim(), nextPostsCursor)}
                  className="user-card border px-6 py-2 rounded-lg text-sm" style={{ borderColor: 'var(--user-border-color)' }}
                >
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

export default function SearchPage() {
  return (
    <Suspense>
      <SearchInner />
    </Suspense>
  );
}
