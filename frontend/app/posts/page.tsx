'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

const BACKEND = '';

interface BrowsePost {
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

export default function PostsBrowsePage() {
  const [posts, setPosts] = useState<BrowsePost[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadPosts = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const url = new URL(`${BACKEND}/api/v1/posts/latest`, window.location.origin);
      url.searchParams.set('limit', '24');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url.toString());
      const data = await res.json() as { posts: BrowsePost[]; nextCursor: string | null };
      setPosts((p) => cursor ? [...p, ...data.posts] : data.posts);
      setNextCursor(data.nextCursor);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPosts(); }, [loadPosts]);

  return (
    <main className="min-h-[calc(100vh-3rem)] user-bg p-6">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Browse Posts</h1>

        {loading && posts.length === 0 ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : posts.length === 0 ? (
          <p className="text-gray-500 text-sm">No posts yet. <Link href="/import" className="text-indigo-400 hover:underline">Import some content</Link> to get started.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {posts.map((post) => {
                const rev = post.revisions[0];
                const title = rev?.title ?? 'Untitled';
                const preview = rev?.content ? stripHtml(rev.content) : '';
                const creatorHref = `/${post.creator.serviceType}/user/${post.creator.externalId}`;
                const postHref = `/posts/${post.id}`;
                return (
                  <div key={post.id} className="user-card rounded-xl p-4 flex flex-col gap-2">
                    <Link href={creatorHref} className="text-xs truncate" style={{ color: 'var(--user-btn-hover-color)' }}>
                      {post.creator.name ?? post.creator.externalId}
                    </Link>
                    <Link href={postHref} className="font-semibold text-white hover:text-indigo-200 line-clamp-2">
                      {title}
                    </Link>
                    {preview && <p className="text-xs text-gray-400 line-clamp-3">{preview}</p>}
                    <div className="flex items-center gap-3 text-xs text-gray-500 mt-auto pt-1">
                      <span>{new Date(post.publishedAt ?? post.createdAt).toLocaleDateString()}</span>
                      {post._count.attachments > 0 && <span>📎 {post._count.attachments}</span>}
                      {post._count.comments > 0 && <span>💬 {post._count.comments}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            {nextCursor && (
              <div className="mt-8 text-center">
                <button
                  onClick={() => loadPosts(nextCursor)}
                  disabled={loading}
                  className="user-btn disabled:opacity-50 px-6 py-2.5 rounded-lg text-sm font-medium"
                >
                  {loading ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
