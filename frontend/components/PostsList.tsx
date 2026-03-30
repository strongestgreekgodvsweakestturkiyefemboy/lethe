'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

const BACKEND_URL = '';

interface PostRevisionSummary {
  title: string | null;
  content: string | null;
}

interface PostCreatorSummary {
  serviceType: string;
  externalId: string;
}

interface PostListItem {
  id: string;
  externalId: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revisions: PostRevisionSummary[];
  tags: { tag: { id: string; name: string } }[];
  _count: { attachments: number; comments: number; revisions: number };
  creator: PostCreatorSummary;
}

interface Props {
  creatorId: string;
}

/** Strip HTML tags and collapse whitespace for plain-text preview. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function PostCard({ post }: { post: PostListItem }) {
  const latest = post.revisions[0];
  const title = latest?.title ?? '(untitled)';
  const rawContent = latest?.content ?? '';
  const preview = rawContent ? stripHtml(rawContent).slice(0, 200) : '';

  const href = `/${post.creator.serviceType}/user/${post.creator.externalId}/post/${post.externalId}`;

  return (
    <Link
      href={href}
      className="user-card rounded-xl p-4 space-y-2"
    >
      <p className="font-semibold text-white line-clamp-2">{title}</p>
      {preview && (
        <p className="text-sm text-gray-400 line-clamp-3">{preview}</p>
      )}
      <div className="flex items-center gap-4 text-xs text-gray-500 pt-1">
        {post.publishedAt && (
          <span>{new Date(post.publishedAt).toLocaleDateString()}</span>
        )}
        {post._count.attachments > 0 && (
          <span>📎 {post._count.attachments}</span>
        )}
        {post._count.comments > 0 && (
          <span>💬 {post._count.comments}</span>
        )}
        {post._count.revisions > 1 && (
          <span>🔄 {post._count.revisions} revisions</span>
        )}
      </div>
      {post.tags && post.tags.length > 0 && (
        <div className="space-y-1 pt-1">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Importer Tags</p>
          <div className="flex flex-wrap gap-1">
            {post.tags.map((pt) => (
              <span key={pt.tag.id} className="text-xs px-2 py-0.5 rounded-full border" style={{ backgroundColor: 'var(--user-card-hover-bg)', borderColor: 'var(--user-border-color)' }}>
                {pt.tag.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </Link>
  );
}

export default function PostsList({ creatorId }: Props) {
  const [posts, setPosts] = useState<PostListItem[]>([]);
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
        if (cursorValue) params.set('cursor', cursorValue);

        const res = await fetch(
          `${BACKEND_URL}/api/v1/creators/${creatorId}/posts?${params.toString()}`,
        );
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        const data = (await res.json()) as { posts: PostListItem[]; nextCursor: string | null };

        setPosts((prev) => (replace ? data.posts : [...prev, ...data.posts]));
        setCursor(data.nextCursor);
        setHasMore(data.nextCursor !== null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    },
    [creatorId],
  );

  useEffect(() => {
    setPosts([]);
    setCursor(null);
    loadPage(null, true);
  }, [loadPage]);

  if (error) {
    return <p className="text-red-400 text-sm">{error}</p>;
  }

  if (!loading && posts.length === 0) {
    return (
      <p className="text-gray-500 text-sm text-center py-12">
        No posts found for this creator.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {posts.map((post) => (
          <PostCard key={post.id} post={post} />
        ))}
      </div>

      {loading && <p className="text-center text-gray-500 text-sm py-4">Loading…</p>}

      {hasMore && !loading && (
        <div className="flex justify-center">
          <button
            onClick={() => loadPage(cursor, false)}
            className="user-btn rounded-lg px-6 py-2 text-sm font-medium"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
