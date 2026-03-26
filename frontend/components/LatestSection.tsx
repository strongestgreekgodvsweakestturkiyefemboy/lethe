'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001';

interface LatestPost {
  id: string;
  publishedAt: string | null;
  createdAt: string;
  creator: { id: string; name: string | null; serviceType: string; externalId: string };
  revisions: { title: string | null; content: string | null }[];
  _count: { attachments: number; comments: number };
}

interface LatestUser {
  id: string;
  username: string | null;
  createdAt: string;
}

function stripHtml(html: string) {
  return html.replace(/<[^>]*>/g, '').slice(0, 120);
}

export default function LatestSection() {
  const [posts, setPosts] = useState<LatestPost[]>([]);
  const [users, setUsers] = useState<LatestUser[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [loadingUsers, setLoadingUsers] = useState(true);

  useEffect(() => {
    fetch(`${BACKEND}/api/v1/posts/latest?limit=6`)
      .then((r) => r.json())
      .then((d) => setPosts(d.posts ?? []))
      .catch(() => {})
      .finally(() => setLoadingPosts(false));

    fetch(`${BACKEND}/api/v1/users?limit=8`)
      .then((r) => r.json())
      .then((d) => setUsers(d.users ?? []))
      .catch(() => {})
      .finally(() => setLoadingUsers(false));
  }, []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      {/* Latest Posts */}
      <div className="lg:col-span-2">
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
          <div className="space-y-3">
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

      {/* Latest Users */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">Latest Users</h2>
          <Link href="/search?tab=users" className="text-sm text-indigo-400 hover:text-indigo-300">
            All users →
          </Link>
        </div>
        {loadingUsers ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : users.length === 0 ? (
          <p className="text-gray-500 text-sm">No accounts yet.</p>
        ) : (
          <div className="bg-gray-900 rounded-xl divide-y divide-gray-800">
            {users.map((u) => (
              <div key={u.id} className="flex items-center gap-3 px-4 py-3">
                <div className="w-8 h-8 rounded-full bg-indigo-600/30 flex items-center justify-center text-indigo-300 font-bold text-sm shrink-0">
                  {(u.username ?? '?')[0].toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white truncate">@{u.username}</p>
                  <p className="text-xs text-gray-500">
                    Joined {new Date(u.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
