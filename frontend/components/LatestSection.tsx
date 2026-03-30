'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const BACKEND = '';

interface LatestPost {
  id: string;
  publishedAt: string | null;
  createdAt: string;
  creator: { id: string; name: string | null; serviceType: string; externalId: string };
  revisions: { title: string | null; content: string | null }[];
  _count: { attachments: number; comments: number };
}

function stripHtml(html: string) {
  return html.replace(/<[^>]*>/g, '').slice(0, 120);
}

export default function LatestSection() {
  const [posts, setPosts] = useState<LatestPost[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND}/api/v1/posts/latest?limit=6`)
      .then((r) => r.json())
      .then((d) => setPosts(d.posts ?? []))
      .catch(() => {})
      .finally(() => setLoadingPosts(false));
  }, []);

  return (
    <div>
      {/* Latest Posts */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">Latest Posts</h2>
          <Link href="/search" className="text-sm text-indigo-400 hover:text-indigo-300">
            Search posts →
          </Link>
        </div>
        {loadingPosts ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : posts.length === 0 ? (
          <p className="text-gray-500 text-sm">No posts yet. <Link href="/import" className="text-indigo-400 hover:underline">Import some content</Link> to get started.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {posts.map((post) => {
              const rev = post.revisions[0];
              const title = rev?.title ?? 'Untitled';
              const preview = rev?.content ? stripHtml(rev.content) : '';
              const href = `/${post.creator.serviceType}/user/${post.creator.externalId}`;
              return (
                <div key={post.id} className="bg-gray-900 rounded-xl p-4 hover:bg-gray-800/80 transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={href} className="text-xs text-indigo-400 hover:text-indigo-300 truncate block">
                        {post.creator.name ?? post.creator.externalId}
                      </Link>
                      <p className="font-medium text-white truncate">{title}</p>
                      {preview && <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{preview}</p>}
                    </div>
                    <div className="text-xs text-gray-500 whitespace-nowrap">
                      {new Date(post.publishedAt ?? post.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
