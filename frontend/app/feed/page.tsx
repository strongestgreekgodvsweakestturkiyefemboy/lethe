'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/AuthContext';

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001';

interface FeedPost {
  id: string;
  publishedAt: string | null;
  createdAt: string;
  creator: { id: string; name: string | null; serviceType: string; externalId: string; thumbnailUrl: string | null };
  revisions: { title: string | null; content: string | null }[];
  attachments: { id: string; dataType: string; fileUrl: string; name: string | null }[];
  _count: { comments: number };
}

function stripHtml(html: string) {
  return html.replace(/<[^>]*>/g, '').slice(0, 200);
}

export default function FeedPage() {
  const { user, token } = useAuth();
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadPosts = useCallback(async (cursor?: string) => {
    if (!token) return;
    setLoading(true);
    try {
      const url = new URL(`${BACKEND}/api/v1/feed`);
      url.searchParams.set('limit', '20');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json() as { posts: FeedPost[]; nextCursor: string | null };
      setPosts((p) => cursor ? [...p, ...data.posts] : data.posts);
      setNextCursor(data.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) loadPosts();
  }, [token, loadPosts]);

  if (!user) {
    return (
      <main className="min-h-[calc(100vh-3rem)] bg-gray-950 text-white flex items-center justify-center p-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">Your Feed</h1>
          <p className="text-gray-400 mb-6">Sign in to see posts from your favourite artists.</p>
          <p className="text-sm text-gray-500">Use the <strong>Sign in</strong> button in the top bar.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100vh-3rem)] bg-gray-950 text-white p-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Your Feed</h1>
          <Link href="/creators" className="text-sm text-indigo-400 hover:text-indigo-300">
            Discover artists →
          </Link>
        </div>

        {!loading && posts.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p className="mb-4">Your feed is empty.</p>
            <p className="text-sm">
              <Link href="/creators" className="text-indigo-400 hover:underline">Browse artists</Link> and favourite some to see their posts here.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {posts.map((post) => {
              const rev = post.revisions[0];
              const title = rev?.title ?? 'Untitled';
              const preview = rev?.content ? stripHtml(rev.content) : '';
              const postHref = `/${post.creator.serviceType}/user/${post.creator.externalId}`;
              return (
                <article key={post.id} className="bg-gray-900 rounded-xl p-5 hover:bg-gray-800/80 transition-colors">
                  <div className="flex items-center gap-2 mb-2">
                    <Link href={postHref} className="text-sm font-medium text-indigo-400 hover:text-indigo-300">
                      {post.creator.name ?? post.creator.externalId}
                    </Link>
                    <span className="text-gray-600">·</span>
                    <span className="text-xs text-gray-500">
                      {new Date(post.publishedAt ?? post.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <h2 className="font-semibold text-white mb-1">{title}</h2>
                  {preview && <p className="text-sm text-gray-300 line-clamp-3">{preview}</p>}
                  {post.attachments.length > 0 && (
                    <p className="text-xs text-gray-500 mt-2">
                      📎 {post.attachments.length} attachment{post.attachments.length !== 1 ? 's' : ''}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        )}

        {loading && <p className="text-center text-gray-500 py-8">Loading…</p>}

        {nextCursor && !loading && (
          <div className="text-center mt-6">
            <button
              onClick={() => loadPosts(nextCursor)}
              className="border border-gray-700 hover:bg-gray-800 px-6 py-2 rounded-lg text-sm transition-colors"
            >
              Load more
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
