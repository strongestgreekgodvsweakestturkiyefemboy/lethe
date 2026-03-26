'use client';

import { useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001';

interface SearchPost {
  id: string;
  publishedAt: string | null;
  createdAt: string;
  creator: { id: string; name: string | null; serviceType: string; externalId: string };
  revisions: { title: string | null; content: string | null }[];
  _count: { attachments: number; comments: number };
}

interface SearchUser {
  id: string;
  username: string | null;
  createdAt: string;
}

function stripHtml(html: string) {
  return html.replace(/<[^>]*>/g, '').slice(0, 150);
}

function SearchInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialQ = searchParams.get('q') ?? '';
  const initialTab = (searchParams.get('tab') ?? 'posts') as 'posts' | 'users';

  const [q, setQ] = useState(initialQ);
  const [tab, setTab] = useState<'posts' | 'users'>(initialTab);
  const [posts, setPosts] = useState<SearchPost[]>([]);
  const [users, setUsers] = useState<SearchUser[]>([]);
  const [nextPostsCursor, setNextPostsCursor] = useState<string | null>(null);
  const [nextUsersCursor, setNextUsersCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const doSearch = useCallback(async (query: string, currentTab: 'posts' | 'users', cursor?: string) => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      if (currentTab === 'posts') {
        const url = new URL(`${BACKEND}/api/v1/search/posts`);
        url.searchParams.set('q', query.trim());
        url.searchParams.set('limit', '20');
        if (cursor) url.searchParams.set('cursor', cursor);
        const res = await fetch(url.toString());
        const data = await res.json() as { posts: SearchPost[]; nextCursor: string | null };
        setPosts((p) => cursor ? [...p, ...data.posts] : data.posts);
        setNextPostsCursor(data.nextCursor);
      } else {
        const url = new URL(`${BACKEND}/api/v1/search/users`);
        url.searchParams.set('q', query.trim());
        url.searchParams.set('limit', '20');
        if (cursor) url.searchParams.set('cursor', cursor);
        const res = await fetch(url.toString());
        const data = await res.json() as { users: SearchUser[]; nextCursor: string | null };
        setUsers((u) => cursor ? [...u, ...data.users] : data.users);
        setNextUsersCursor(data.nextCursor);
      }
    } finally {
      setLoading(false);
      setSearched(true);
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setPosts([]);
    setUsers([]);
    setNextPostsCursor(null);
    setNextUsersCursor(null);
    setSearched(false);
    router.replace(`/search?q=${encodeURIComponent(q.trim())}&tab=${tab}`);
    doSearch(q.trim(), tab);
  };

  const switchTab = (newTab: 'posts' | 'users') => {
    setTab(newTab);
    setPosts([]);
    setUsers([]);
    setNextPostsCursor(null);
    setNextUsersCursor(null);
    setSearched(false);
    if (q.trim()) {
      router.replace(`/search?q=${encodeURIComponent(q.trim())}&tab=${newTab}`);
      doSearch(q.trim(), newTab);
    }
  };

  return (
    <main className="min-h-[calc(100vh-3rem)] bg-gray-950 text-white p-6">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Search</h1>

        {/* Search bar */}
        <form onSubmit={handleSubmit} className="flex gap-2 mb-6">
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search posts or users…"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            type="submit"
            disabled={!q.trim() || loading}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-5 py-2 rounded-lg font-medium transition-colors"
          >
            Search
          </button>
        </form>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-gray-800">
          {(['posts', 'users'] as const).map((t) => (
            <button
              key={t}
              onClick={() => switchTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${
                tab === t
                  ? 'border-indigo-500 text-white'
                  : 'border-transparent text-gray-400 hover:text-white'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Results */}
        {loading && <p className="text-gray-500 text-sm">Searching…</p>}

        {!loading && searched && tab === 'posts' && (
          <>
            {posts.length === 0 ? (
              <p className="text-gray-400">No posts found for &ldquo;{q}&rdquo;.</p>
            ) : (
              <div className="space-y-3">
                {posts.map((post) => {
                  const rev = post.revisions[0];
                  const title = rev?.title ?? 'Untitled';
                  const preview = rev?.content ? stripHtml(rev.content) : '';
                  const href = `/${post.creator.serviceType}/user/${post.creator.externalId}`;
                  return (
                    <div key={post.id} className="bg-gray-900 rounded-xl p-4">
                      <Link href={href} className="text-xs text-indigo-400 hover:text-indigo-300">
                        {post.creator.name ?? post.creator.externalId}
                      </Link>
                      <p className="font-medium text-white">{title}</p>
                      {preview && <p className="text-sm text-gray-400 mt-1 line-clamp-2">{preview}</p>}
                      <p className="text-xs text-gray-600 mt-1">
                        {new Date(post.publishedAt ?? post.createdAt).toLocaleDateString()}
                        {' · '}
                        {post._count.attachments} attachment{post._count.attachments !== 1 ? 's' : ''}
                        {' · '}
                        {post._count.comments} comment{post._count.comments !== 1 ? 's' : ''}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
            {nextPostsCursor && !loading && (
              <div className="text-center mt-4">
                <button
                  onClick={() => doSearch(q.trim(), 'posts', nextPostsCursor)}
                  className="border border-gray-700 hover:bg-gray-800 px-6 py-2 rounded-lg text-sm transition-colors"
                >
                  Load more
                </button>
              </div>
            )}
          </>
        )}

        {!loading && searched && tab === 'users' && (
          <>
            {users.length === 0 ? (
              <p className="text-gray-400">No users found for &ldquo;{q}&rdquo;.</p>
            ) : (
              <div className="bg-gray-900 rounded-xl divide-y divide-gray-800">
                {users.map((u) => (
                  <div key={u.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="w-8 h-8 rounded-full bg-indigo-600/30 flex items-center justify-center text-indigo-300 font-bold text-sm shrink-0">
                      {(u.username ?? '?')[0].toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white">@{u.username}</p>
                      <p className="text-xs text-gray-500">
                        Joined {new Date(u.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {nextUsersCursor && !loading && (
              <div className="text-center mt-4">
                <button
                  onClick={() => doSearch(q.trim(), 'users', nextUsersCursor)}
                  className="border border-gray-700 hover:bg-gray-800 px-6 py-2 rounded-lg text-sm transition-colors"
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
