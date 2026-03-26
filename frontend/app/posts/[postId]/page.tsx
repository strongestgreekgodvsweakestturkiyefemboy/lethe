'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
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
    } catch { /* keep original */ }
  }
  return result;
}

// ── Components ────────────────────────────────────────────────────────────────

function AttachmentViewer({ attachment }: { attachment: PostAttachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetchPresignedUrl(attachment.fileUrl).then(setUrl).catch(() => setError(true));
  }, [attachment.fileUrl]);

  const filename = attachment.name ?? attachment.fileUrl.split('/').pop() ?? 'file';

  if (error) return <div className="bg-gray-800 rounded-xl p-4 text-center text-gray-500 text-sm">Media unavailable</div>;
  if (!url) return <div className="bg-gray-800 rounded-xl p-4 flex items-center justify-center text-gray-600 text-sm aspect-video animate-pulse">Loading…</div>;

  if (attachment.dataType === 'IMAGE') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt={filename} className="w-full rounded-xl object-cover max-h-[600px]" />
    );
  }
  if (attachment.dataType === 'VIDEO') {
    return <video controls className="w-full rounded-xl" preload="metadata"><source src={url} /></video>;
  }
  if (attachment.dataType === 'AUDIO') {
    return (
      <div className="bg-gray-800 rounded-xl p-4">
        <audio controls className="w-full"><source src={url} /></audio>
        <p className="text-xs text-gray-500 mt-2">{filename}</p>
      </div>
    );
  }
  return (
    <div className="bg-gray-800 rounded-xl p-4 flex items-center gap-3">
      <span className="text-2xl">📄</span>
      <div className="flex-1 min-w-0"><p className="text-sm font-medium text-gray-200 truncate">{filename}</p></div>
      <a href={url} download={filename} className="shrink-0 bg-indigo-700 hover:bg-indigo-600 text-white text-xs font-medium rounded-lg px-3 py-1.5 transition-colors">Download</a>
    </div>
  );
}

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
    <img src={thumbUrl} alt={displayName} className="w-12 h-12 rounded-lg object-cover shrink-0" />
  ) : (
    <div className="w-12 h-12 rounded-lg bg-gray-600 shrink-0 flex items-center justify-center text-gray-300 font-semibold text-lg">{initial}</div>
  );
}

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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PostDetailPage() {
  const { postId } = useParams<{ postId: string }>();
  const [post, setPost] = useState<PostDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRevisionIdx, setSelectedRevisionIdx] = useState(0);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/v1/posts/${postId}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        return res.json() as Promise<{ post: PostDetail }>;
      })
      .then(({ post }) => { setPost(post); setSelectedRevisionIdx(0); })
      .catch((err) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, [postId]);

  if (loading) return <div className="min-h-[calc(100vh-3rem)] bg-gray-950 text-white flex items-center justify-center">Loading…</div>;
  if (error || !post) return <div className="min-h-[calc(100vh-3rem)] bg-gray-950 text-white flex items-center justify-center"><p className="text-red-400">{error ?? 'Post not found'}</p></div>;

  const selectedRevision = post.revisions[selectedRevisionIdx];

  return (
    <div className="min-h-[calc(100vh-3rem)] bg-gray-950 text-white">
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {/* Nav */}
        <Link href={`/${post.creator.serviceType}/user/${post.creator.externalId}`} className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
          ← {post.creator.name ?? post.creator.externalId}
        </Link>

        {/* Post header */}
        <div className="bg-gray-800 rounded-xl p-5 space-y-4">
          <div className="flex gap-4">
            <CreatorAvatar creator={post.creator} />
            <div className="flex-1 min-w-0 space-y-2">
              <h1 className="text-2xl font-bold leading-tight">{selectedRevision?.title ?? '(untitled)'}</h1>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                {post.publishedAt && (
                  <><span className="text-gray-400">Published:</span><span className="text-gray-300">{new Date(post.publishedAt).toLocaleDateString()}</span></>
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
            </div>
          </div>
        </div>

        {/* Post body */}
        {selectedRevision?.content && (
          <section>
            <h2 className="text-base font-semibold text-gray-300 mb-3">Content</h2>
            <PostContent html={selectedRevision.content} />
          </section>
        )}

        {/* Attachments */}
        {post.attachments.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-300">Files ({post.attachments.length})</h2>
            <div className="space-y-4">
              {post.attachments.map((att) => <AttachmentViewer key={att.id} attachment={att} />)}
            </div>
          </section>
        )}

        {/* Comments */}
        {post.comments.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-300">Comments ({post.comments.length})</h2>
            <div className="space-y-3">
              {post.comments.map((comment) => (
                <div key={comment.id} className="bg-gray-800 rounded-xl p-4 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-indigo-300">{comment.authorName ?? 'Anonymous'}</span>
                    {comment.publishedAt && <span className="text-xs text-gray-500">{new Date(comment.publishedAt).toLocaleString()}</span>}
                  </div>
                  <div
                    className="text-sm text-gray-300"
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: comment.revisions[0]?.content ?? '' }}
                  />
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
