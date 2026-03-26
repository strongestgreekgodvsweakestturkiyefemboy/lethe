'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

const BACKEND_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001')
    : 'http://localhost:3001';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PostRevision {
  id: string;
  title: string | null;
  content: string | null;
  createdAt: string;
  revisionExternalId?: string | null;
}

interface PostAttachment {
  id: string;
  fileUrl: string;
  dataType: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';
  name: string | null;
  createdAt: string;
}

interface CommentRevision {
  id: string;
  content: string;
  createdAt: string;
}

interface Comment {
  id: string;
  externalId: string;
  authorName: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revisions: CommentRevision[];
}

interface PostCreator {
  id: string;
  sourceSite: string;
  serviceType: string;
  externalId: string;
  name: string | null;
  thumbnailUrl: string | null;
  bannerUrl: string | null;
}

interface PostDetail {
  id: string;
  externalId: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  creator: PostCreator;
  revisions: PostRevision[];
  attachments: PostAttachment[];
  comments: Comment[];
}

interface PostListItem {
  id: string;
  externalId: string;
  publishedAt: string | null;
  revisions: { title: string | null; content: string | null }[];
}

// ── Presign helpers ────────────────────────────────────────────────────────────

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

/** Replace <img src="..."> in HTML content with presigned URLs. */
async function presignContentImages(html: string): Promise<string> {
  const imgRegex = /<img([^>]*)\ssrc="([^"]+)"([^>]*)>/gi;
  const matches = [...html.matchAll(imgRegex)];
  if (matches.length === 0) return html;

  let result = html;
  for (const match of matches) {
    const [fullMatch, before, src, after] = match;
    try {
      const presigned = await fetchPresignedUrl(src);
      result = result.replace(fullMatch, `<img${before} src="${presigned}"${after}>`);
    } catch {
      // keep original src on failure
    }
  }
  return result;
}

// ── Attachment viewer ─────────────────────────────────────────────────────────

function AttachmentViewer({ attachment }: { attachment: PostAttachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetchPresignedUrl(attachment.fileUrl)
      .then(setUrl)
      .catch(() => setError(true));
  }, [attachment.fileUrl]);

  const filename = attachment.name ?? attachment.fileUrl.split('/').pop() ?? 'file';

  if (error) {
    return (
      <div className="bg-gray-800 rounded-xl p-4 text-center text-gray-500 text-sm">
        Media unavailable
      </div>
    );
  }

  if (!url) {
    return (
      <div className="bg-gray-800 rounded-xl p-4 flex items-center justify-center text-gray-600 text-sm aspect-video animate-pulse">
        Loading…
      </div>
    );
  }

  if (attachment.dataType === 'IMAGE') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt={filename} className="w-full rounded-xl object-cover max-h-[600px]" />
    );
  }

  if (attachment.dataType === 'VIDEO') {
    return (
      <video controls className="w-full rounded-xl" preload="metadata">
        <source src={url} />
        Your browser does not support video playback.
      </video>
    );
  }

  if (attachment.dataType === 'AUDIO') {
    return (
      <div className="bg-gray-800 rounded-xl p-4">
        <audio controls className="w-full">
          <source src={url} />
          Your browser does not support audio playback.
        </audio>
        <p className="text-xs text-gray-500 mt-2">{filename}</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-xl p-4 flex items-center gap-3">
      <span className="text-2xl">📄</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-200 truncate">{filename}</p>
      </div>
      <a
        href={url}
        download={filename}
        className="shrink-0 bg-indigo-700 hover:bg-indigo-600 text-white text-xs font-medium rounded-lg px-3 py-1.5 transition-colors"
      >
        Download
      </a>
    </div>
  );
}

// ── Creator avatar ─────────────────────────────────────────────────────────────

function CreatorAvatar({ creator }: { creator: PostCreator }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const displayName = creator.name ?? creator.externalId;
  const initial = displayName[0]?.toUpperCase() ?? '?';

  useEffect(() => {
    if (creator.thumbnailUrl) {
      fetchPresignedUrl(creator.thumbnailUrl).then(setThumbUrl).catch(() => setThumbUrl(null));
    }
  }, [creator.thumbnailUrl]);

  return thumbUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={thumbUrl}
      alt={displayName}
      className="w-12 h-12 rounded-lg object-cover shrink-0"
    />
  ) : (
    <div className="w-12 h-12 rounded-lg bg-gray-600 shrink-0 flex items-center justify-center text-gray-300 font-semibold text-lg">
      {initial}
    </div>
  );
}

// ── Post content with presigned images ────────────────────────────────────────

function PostContent({ html }: { html: string }) {
  const [processedHtml, setProcessedHtml] = useState(html);

  useEffect(() => {
    presignContentImages(html).then(setProcessedHtml).catch(() => setProcessedHtml(html));
  }, [html]);

  return (
    <div
      className="prose prose-invert max-w-none text-gray-200 prose-img:rounded-xl prose-img:max-h-[600px] prose-img:object-cover"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: processedHtml }}
    />
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function PostSidebar({
  posts,
  currentExternalId,
  service,
  creatorId,
  onClose,
}: {
  posts: PostListItem[];
  currentExternalId: string;
  service: string;
  creatorId: string;
  onClose: () => void;
}) {
  return (
    <aside className="w-72 shrink-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col max-h-[calc(100vh-8rem)] sticky top-16">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <span className="text-sm font-semibold text-gray-200">All Posts</span>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-white transition-colors text-xs"
          aria-label="Close sidebar"
        >
          ✕
        </button>
      </div>
      <ul className="overflow-y-auto flex-1 divide-y divide-gray-800">
        {posts.map((p) => {
          const title = p.revisions[0]?.title ?? '(untitled)';
          const isActive = p.externalId === currentExternalId;
          return (
            <li key={p.id}>
              <Link
                href={`/${service}/user/${creatorId}/post/${p.externalId}`}
                className={`block px-4 py-2.5 text-sm transition-colors line-clamp-2 ${
                  isActive
                    ? 'bg-indigo-900/50 text-indigo-300 font-medium'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
              >
                {title}
                {p.publishedAt && (
                  <span className="block text-xs text-gray-600 mt-0.5">
                    {new Date(p.publishedAt).toLocaleDateString()}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PostSemanticDetailPage() {
  const { service, creatorId, postId } = useParams<{
    service: string;
    creatorId: string;
    postId: string;
  }>();
  const router = useRouter();

  const [post, setPost] = useState<PostDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Revision selector — index into post.revisions
  const [selectedRevisionIdx, setSelectedRevisionIdx] = useState(0);

  // Sidebar
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [allPosts, setAllPosts] = useState<PostListItem[]>([]);
  const allPostsLoadedRef = useRef(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setSelectedRevisionIdx(0);
    fetch(`${BACKEND_URL}/api/v1/${service}/user/${creatorId}/post/${postId}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        return res.json() as Promise<{ post: PostDetail }>;
      })
      .then(({ post }) => setPost(post))
      .catch((err) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, [service, creatorId, postId]);

  // Fetch all posts for sidebar + navigation (lazily when sidebar opens)
  const loadAllPosts = useCallback(async () => {
    if (allPostsLoadedRef.current) return;
    allPostsLoadedRef.current = true;
    try {
      const params = new URLSearchParams({ limit: '100' });
      const res = await fetch(
        `${BACKEND_URL}/api/v1/${service}/user/${creatorId}?${params.toString()}`,
      );
      if (!res.ok) { allPostsLoadedRef.current = false; return; }
      const data = (await res.json()) as { posts: PostListItem[] };
      setAllPosts(data.posts);
    } catch {
      allPostsLoadedRef.current = false; // allow retry
    }
  }, [service, creatorId]);

  // Load posts on mount since sidebar is open by default
  useEffect(() => {
    loadAllPosts();
  }, [loadAllPosts]);

  const handleSidebarToggle = () => {
    setSidebarOpen((v) => !v);
    loadAllPosts();
  };

  // Back / forward navigation
  const currentIdx = allPosts.findIndex((p) => p.externalId === postId);
  const prevPost = currentIdx > 0 ? allPosts[currentIdx - 1] : null;
  const nextPost = currentIdx >= 0 && currentIdx < allPosts.length - 1 ? allPosts[currentIdx + 1] : null;

  const navigate = (externalId: string) => {
    router.push(`/${service}/user/${creatorId}/post/${externalId}`);
  };

  if (loading) {
    return (
      <div className="min-h-[calc(100vh-3rem)] bg-gray-950 text-white flex items-center justify-center">
        Loading…
      </div>
    );
  }

  if (error || !post) {
    return (
      <div className="min-h-[calc(100vh-3rem)] bg-gray-950 text-white flex items-center justify-center">
        <p className="text-red-400">{error ?? 'Post not found'}</p>
      </div>
    );
  }

  const selectedRevision = post.revisions[selectedRevisionIdx];

  return (
    <div className="min-h-[calc(100vh-3rem)] bg-gray-950 text-white">
      <div className="max-w-7xl mx-auto px-4 py-6 flex gap-6">
        {/* Sidebar */}
        {sidebarOpen && (
          <PostSidebar
            posts={allPosts}
            currentExternalId={postId}
            service={service}
            creatorId={creatorId}
            onClose={() => setSidebarOpen(false)}
          />
        )}

        {/* Main content */}
        <div className="flex-1 min-w-0 space-y-6">
          {/* Nav row */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleSidebarToggle}
              className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors text-gray-400 hover:text-white"
              aria-label="Toggle post list"
              title="Browse all posts"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>

            <Link
              href={`/${post.creator.serviceType}/user/${post.creator.externalId}`}
              className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              ← {post.creator.name ?? post.creator.externalId}
            </Link>

            <div className="flex-1" />

            {/* Back / forward */}
            {allPosts.length > 0 && (
              <div className="flex items-center gap-1">
                <button
                  disabled={!prevPost}
                  onClick={() => prevPost && navigate(prevPost.externalId)}
                  className="px-3 py-1.5 rounded-lg text-sm bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title="Previous post"
                >
                  ‹ Prev
                </button>
                <button
                  disabled={!nextPost}
                  onClick={() => nextPost && navigate(nextPost.externalId)}
                  className="px-3 py-1.5 rounded-lg text-sm bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title="Next post"
                >
                  Next ›
                </button>
              </div>
            )}
          </div>

          {/* Post header */}
          <div className="bg-gray-800 rounded-xl p-5 space-y-4">
            <div className="flex gap-4">
              {/* Creator avatar */}
              <CreatorAvatar creator={post.creator} />

              {/* Title + meta */}
              <div className="flex-1 min-w-0 space-y-2">
                <h1 className="text-2xl font-bold leading-tight">
                  {selectedRevision?.title ?? '(untitled)'}
                </h1>
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  {post.publishedAt && (
                    <>
                      <span className="text-gray-400">Published:</span>
                      <span className="text-gray-300">{new Date(post.publishedAt).toLocaleDateString()}</span>
                    </>
                  )}
                  {post.updatedAt && post.updatedAt !== post.createdAt && (
                    <>
                      <span className="text-gray-400">Edited:</span>
                      <span className="text-gray-300">{new Date(post.updatedAt).toLocaleDateString()}</span>
                    </>
                  )}
                  {post.revisions.length > 1 && (
                    <>
                      <span className="text-gray-400">Revision:</span>
                      <select
                        value={selectedRevisionIdx}
                        onChange={(e) => setSelectedRevisionIdx(Number(e.target.value))}
                        className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-0.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 w-fit"
                      >
                        {post.revisions.map((rev, idx) => (
                          <option key={rev.id} value={idx}>
                            {new Date(rev.createdAt).toLocaleDateString('en', { year: 'numeric', month: 'short' })}
                            {idx === 0 ? ' [current]' : ` [${rev.revisionExternalId ?? idx}]`}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
                <div className="text-xs text-gray-500">
                  {post.creator.name ?? post.creator.externalId} · {post.creator.serviceType} · {post.creator.sourceSite}
                </div>
              </div>
            </div>
          </div>

          {/* Post body */}
          {selectedRevision?.content && (
            <section className="space-y-2">
              <h2 className="text-base font-semibold text-gray-300">Content</h2>
              <PostContent html={selectedRevision.content} />
            </section>
          )}

          {/* Attachments */}
          {post.attachments.length > 0 && (
            <section className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-300">
                Files ({post.attachments.length})
              </h2>
              <div className="space-y-4">
                {post.attachments.map((att) => (
                  <AttachmentViewer key={att.id} attachment={att} />
                ))}
              </div>
            </section>
          )}

          {/* Comments */}
          {post.comments.length > 0 && (
            <section className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-300">
                Comments ({post.comments.length})
              </h2>
              <div className="space-y-3">
                {post.comments.map((comment) => {
                  const latestContent = comment.revisions[0]?.content ?? '';
                  return (
                    <div key={comment.id} className="bg-gray-800 rounded-xl p-4 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-indigo-300">
                          {comment.authorName ?? 'Anonymous'}
                        </span>
                        {comment.publishedAt && (
                          <span className="text-xs text-gray-500">
                            {new Date(comment.publishedAt).toLocaleString()}
                          </span>
                        )}
                        {comment.revisions.length > 1 && (
                          <span className="text-xs text-gray-600">
                            · {comment.revisions.length} revisions
                          </span>
                        )}
                      </div>
                      <div
                        className="text-sm text-gray-300"
                        // eslint-disable-next-line react/no-danger
                        dangerouslySetInnerHTML={{ __html: latestContent }}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
