'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/components/AuthContext';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

const BACKEND = '';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Tag {
  id: string;
  name: string;
  createdAt: string;
  _count?: { posts: number };
}

interface PostRevision {
  title: string | null;
  content: string | null;
}

interface AdminPost {
  id: string;
  externalId: string;
  publishedAt: string | null;
  createdAt: string;
  revisions: PostRevision[];
  tags: { tag: Tag }[];
  creator: { id: string; name: string | null; serviceType: string; externalId: string };
  _count: { attachments: number; comments: number };
}

interface AdminCreator {
  id: string;
  name: string | null;
  serviceType: string;
  externalId: string;
  sourceSite: string;
  createdAt: string;
  _count: { posts: number };
}

interface AdminJob {
  id: string;
  targetSite: string;
  status: string;
  progressPct: number | null;
  errorMessage: string | null;
  saveSession: boolean;
  creatorExternalId: string | null;
  createdAt: string;
  updatedAt: string;
  user: { id: string; username: string | null } | null;
}

interface DiscordChannel {
  id: string;
  channelId: string;
  name: string;
  type: string;
  isVisible: boolean;
  parentId: string | null;
  position: number | null;
}

interface DiscordServer {
  id: string;
  guildId: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

type Tab = 'posts' | 'tags' | 'creators' | 'jobs' | 'channels' | 'importers';

function authHeaders(token: string | null) {
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function stripHtml(html: string) {
  return html.replace(/<[^>]*>/g, '').slice(0, 120);
}

// ---------------------------------------------------------------------------
// Jobs panel
// ---------------------------------------------------------------------------

function JobsPanel({ token }: { token: string | null }) {
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reimporting, setReimporting] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');

  const loadJobs = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const url = new URL(`${BACKEND}/api/v1/admin/jobs`, window.location.origin);
      url.searchParams.set('limit', '20');
      if (cursor) url.searchParams.set('cursor', cursor);
      if (statusFilter) url.searchParams.set('status', statusFilter);
      const res = await fetch(url.toString(), { headers: authHeaders(token) });
      const data = await res.json() as { jobs: AdminJob[]; nextCursor: string | null };
      setJobs((j) => cursor ? [...j, ...(data.jobs ?? [])] : (data.jobs ?? []));
      setNextCursor(data.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [token, statusFilter]);

  useEffect(() => { setJobs([]); setNextCursor(null); loadJobs(); }, [loadJobs]);

  const handleReimport = async (jobId: string) => {
    setReimporting(jobId);
    try {
      const res = await fetch(`${BACKEND}/api/v1/admin/jobs/${jobId}/reimport`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      const data = await res.json() as { jobId?: string; error?: string };
      if (!res.ok) { alert(data.error ?? 'Failed'); return; }
      alert(`New job created: ${data.jobId}`);
    } finally {
      setReimporting(null);
    }
  };

  const STATUS_COLORS: Record<string, string> = {
    PENDING: 'bg-yellow-500/20 text-yellow-300',
    RUNNING: 'bg-blue-500/20 text-blue-300',
    DONE: 'bg-green-500/20 text-green-300',
    FAILED: 'bg-red-500/20 text-red-300',
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="user-input border rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="">All statuses</option>
          {['PENDING', 'RUNNING', 'DONE', 'FAILED'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button onClick={() => loadJobs()} disabled={loading} className="text-sm text-indigo-400 hover:text-indigo-300 disabled:opacity-50">Refresh</button>
      </div>

      {loading && jobs.length === 0 ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : jobs.length === 0 ? (
        <p className="text-gray-500 text-sm">No jobs found.</p>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <div key={job.id} className="user-card rounded-xl p-4 flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[job.status] ?? 'bg-[var(--user-card-hover-bg)] opacity-70'}`}>{job.status}</span>
                  <span className="font-medium text-white text-sm">{job.targetSite}</span>
                  {job.creatorExternalId && <span className="text-xs text-gray-400">{job.creatorExternalId}</span>}
                </div>
                {job.saveSession && (
                  <button
                    onClick={() => handleReimport(job.id)}
                    disabled={reimporting === job.id}
                    className="text-xs user-btn disabled:opacity-50 px-3 py-1 rounded-lg"
                  >
                    {reimporting === job.id ? 'Starting…' : 'Force Reimport'}
                  </button>
                )}
              </div>
              {job.errorMessage && <p className="text-xs text-red-400">{job.errorMessage}</p>}
              <p className="text-xs text-gray-500">
                User: {job.user?.username ?? job.user?.id ?? 'unknown'} ·{' '}
                {new Date(job.createdAt).toLocaleString()}
                {job.progressPct != null && ` · ${job.progressPct}%`}
              </p>
            </div>
          ))}
          {nextCursor && (
            <button onClick={() => loadJobs(nextCursor)} disabled={loading} className="text-sm text-indigo-400 hover:text-indigo-300 disabled:opacity-50 mt-2">
              Load more…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel visibility panel
// ---------------------------------------------------------------------------

function ChannelsPanel({ token }: { token: string | null }) {
  const [servers, setServers] = useState<DiscordServer[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [channels, setChannels] = useState<DiscordChannel[]>([]);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BACKEND}/api/v1/discord/servers`, { headers: authHeaders(token) })
      .then((r) => r.json())
      .then((d) => setServers(d.servers ?? []))
      .catch(() => {});
  }, [token]);

  const loadChannels = async (serverId: string) => {
    setSelectedServerId(serverId);
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND}/api/v1/admin/discord/servers/${serverId}/channels`, { headers: authHeaders(token) });
      const data = await res.json() as { channels: DiscordChannel[] };
      setChannels(data.channels ?? []);
    } finally {
      setLoading(false);
    }
  };

  const toggleVisibility = async (channelId: string, current: boolean) => {
    setToggling(channelId);
    try {
      const res = await fetch(`${BACKEND}/api/v1/admin/channels/${channelId}/visibility`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ isVisible: !current }),
      });
      if (res.ok) {
        setChannels((ch) => ch.map((c) => c.id === channelId ? { ...c, isVisible: !current } : c));
      }
    } finally {
      setToggling(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-2 text-gray-300">Select Server</label>
        <div className="flex flex-wrap gap-2">
          {servers.length === 0 && <p className="text-gray-500 text-sm">No Discord servers imported yet.</p>}
          {servers.map((s) => (
            <button
              key={s.id}
              onClick={() => loadChannels(s.id)}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${selectedServerId === s.id ? 'user-btn' : 'user-card border'}`}
              style={selectedServerId !== s.id ? { borderColor: 'var(--user-border-color)' } : undefined}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading channels…</p>}

      {!loading && channels.length > 0 && (
        <div className="user-section-bg rounded-xl divide-y" style={{ borderColor: 'var(--user-border-color)' }}>
          {channels.map((ch) => (
            <div key={ch.id} className="flex items-center justify-between px-4 py-3 gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">#{ch.name}</p>
                <p className="text-xs text-gray-500">{ch.type}{ch.parentId ? ' · in category' : ''}</p>
              </div>
              <button
                onClick={() => toggleVisibility(ch.id, ch.isVisible)}
                disabled={toggling === ch.id}
                className={`shrink-0 px-3 py-1 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${ch.isVisible ? 'bg-green-600/30 text-green-300 hover:bg-green-600/50' : 'user-sidebar-bg opacity-60'}`}
              >
                {toggling === ch.id ? '…' : ch.isVisible ? 'Visible' : 'Hidden'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tag manager panel
// ---------------------------------------------------------------------------

function TagsPanel({ token }: { token: string | null }) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [newTagName, setNewTagName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTags = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND}/api/v1/tags`);
      const data = await res.json() as { tags: Tag[] };
      setTags(data.tags ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTags(); }, [loadTags]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTagName.trim()) return;
    setError(null);
    try {
      const res = await fetch(`${BACKEND}/api/v1/admin/tags`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ name: newTagName.trim() }),
      });
      if (!res.ok) {
        const d = await res.json() as { error: string };
        setError(d.error ?? 'Failed to create tag');
        return;
      }
      setNewTagName('');
      await loadTags();
    } catch {
      setError('Network error');
    }
  };

  const handleDelete = async (tagId: string) => {
    if (!confirm('Delete this tag? It will be removed from all posts.')) return;
    try {
      await fetch(`${BACKEND}/api/v1/admin/tags/${tagId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
      await loadTags();
    } catch {
      setError('Failed to delete tag');
    }
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Tag Vocabulary</h2>

      {/* Create form */}
      <form onSubmit={handleCreate} className="flex gap-2 mb-4">
        <input
          type="text"
          value={newTagName}
          onChange={(e) => setNewTagName(e.target.value)}
          className="flex-1 user-input border rounded-lg px-3 py-2 focus:outline-none text-sm"
          placeholder="New tag name…"
        />
        <button
          type="submit"
          disabled={!newTagName.trim()}
          className="user-btn disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium"
        >
          Add tag
        </button>
      </form>
      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

      {/* Tag list */}
      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : tags.length === 0 ? (
        <p className="text-gray-500 text-sm">No tags yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span
              key={tag.id}
              className="flex items-center gap-1.5 user-card border rounded-full px-3 py-1 text-sm"
              style={{ borderColor: 'var(--user-border-color)' }}
            >
              <span style={{ color: 'var(--user-btn-hover-color)' }}>{tag.name}</span>
              {tag._count !== undefined && (
                <span className="text-gray-500 text-xs">({tag._count.posts})</span>
              )}
              <button
                onClick={() => handleDelete(tag.id)}
                className="text-gray-500 hover:text-red-400 ml-0.5 transition-colors"
                title="Delete tag"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Edit post modal
// ---------------------------------------------------------------------------

function EditPostModal({
  post,
  token,
  onClose,
  onSaved,
}: {
  post: AdminPost;
  token: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const current = post.revisions[0];
  const [title, setTitle] = useState(current?.title ?? '');
  const [content, setContent] = useState(current?.content ?? '');
  const [tagInput, setTagInput] = useState(post.tags.map((pt) => pt.tag.name).join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // Update post content
      const patchRes = await fetch(`${BACKEND}/api/v1/admin/posts/${post.id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ title: title || null, content: content || null }),
      });
      if (!patchRes.ok) {
        const d = await patchRes.json() as { error: string };
        setError(d.error ?? 'Failed to save');
        return;
      }

      // Replace tags in a single PUT request
      const newTags = tagInput.split(',').map((t) => t.trim()).filter(Boolean);
      const tagsRes = await fetch(`${BACKEND}/api/v1/admin/posts/${post.id}/tags`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify({ tags: newTags }),
      });
      if (!tagsRes.ok) {
        const d = await tagsRes.json() as { error: string };
        setError(d.error ?? 'Failed to update tags');
        return;
      }

      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="user-card border rounded-2xl w-full max-w-lg shadow-2xl" style={{ borderColor: 'var(--user-border-color)' }}>
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--user-border-color)' }}>
          <h3 className="font-semibold">Edit Post</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">✕</button>
        </div>
        <form onSubmit={handleSave} className="p-6 space-y-4">
          <div>
            <label className="block text-xs mb-1" style={{ opacity: 0.6 }}>Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Post title…"
              className="w-full user-input border rounded-lg px-3 py-2 text-sm focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs mb-1" style={{ opacity: 0.6 }}>Content (HTML)</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              placeholder="Post content…"
              className="w-full user-input border rounded-lg px-3 py-2 text-sm focus:outline-none resize-y"
            />
          </div>
          <div>
            <label className="block text-xs mb-1" style={{ opacity: 0.6 }}>Tags (comma-separated)</label>
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="tag1, tag2, …"
              className="w-full user-input border rounded-lg px-3 py-2 text-sm focus:outline-none"
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex gap-3 justify-end">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg user-card border transition-colors" style={{ borderColor: 'var(--user-border-color)' }}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg user-btn disabled:opacity-50 font-medium"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Posts panel
// ---------------------------------------------------------------------------

function PostsPanel({ token }: { token: string | null }) {
  const [query, setQuery] = useState('');
  const [posts, setPosts] = useState<AdminPost[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingPost, setEditingPost] = useState<AdminPost | null>(null);

  const loadPosts = useCallback(async (q: string, cursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL(`${BACKEND}/api/v1/admin/posts`);
      if (q.trim()) url.searchParams.set('q', q.trim());
      url.searchParams.set('limit', '20');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url.toString(), { headers: authHeaders(token) });
      const data = await res.json() as { posts: AdminPost[]; nextCursor: string | null };
      setPosts((p) => cursor ? [...p, ...data.posts] : data.posts);
      setNextCursor(data.nextCursor);
    } catch {
      setError('Failed to load posts');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { loadPosts(''); }, [loadPosts]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPosts([]);
    setNextCursor(null);
    loadPosts(query);
  };

  const handleDelete = async (postId: string) => {
    if (!confirm('Permanently delete this post and all its attachments, comments, and revisions?')) return;
    try {
      const res = await fetch(`${BACKEND}/api/v1/admin/posts/${postId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
      if (!res.ok) {
        const d = await res.json() as { error: string };
        setError(d.error ?? 'Delete failed');
        return;
      }
      setPosts((p) => p.filter((post) => post.id !== postId));
    } catch {
      setError('Network error');
    }
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Posts</h2>

      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 user-input border rounded-lg px-3 py-2 focus:outline-none text-sm"
          placeholder="Search posts…"
        />
        <button
          type="submit"
          className="user-btn px-4 py-2 rounded-lg text-sm font-medium"
        >
          Search
        </button>
      </form>

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
      {loading && <p className="text-gray-500 text-sm">Loading…</p>}

      {!loading && posts.length === 0 && (
        <p className="text-gray-500 text-sm">No posts found.</p>
      )}

      <div className="space-y-3">
        {posts.map((post) => {
          const rev = post.revisions[0];
          const title = rev?.title ?? 'Untitled';
          const preview = rev?.content ? stripHtml(rev.content) : '';
          return (
            <div key={post.id} className="user-card border rounded-xl p-4 flex gap-4" style={{ borderColor: 'var(--user-border-color)' }}>
              <div className="flex-1 min-w-0">
                <div className="flex items-start gap-2 flex-wrap">
                  <Link
                    href={`/${post.creator.serviceType}/user/${post.creator.externalId}`}
                    className="text-xs shrink-0 transition-colors" style={{ color: 'var(--user-btn-hover-color)' }}
                  >
                    {post.creator.name ?? post.creator.externalId}
                  </Link>
                  <span className="text-xs text-gray-600">·</span>
                  <span className="text-xs text-gray-500">
                    {new Date(post.publishedAt ?? post.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="font-medium text-white mt-0.5 truncate">{title}</p>
                {preview && <p className="text-sm text-gray-400 mt-0.5 line-clamp-2">{preview}</p>}
                {post.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {post.tags.map((pt) => (
                      <span key={pt.tag.id} className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'color-mix(in srgb, var(--user-btn-color) 20%, transparent)', color: 'var(--user-btn-hover-color)' }}>
                        {pt.tag.name}
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-xs text-gray-600 mt-1">
                  {post._count.attachments} attachment{post._count.attachments !== 1 ? 's' : ''}
                  {' · '}
                  {post._count.comments} comment{post._count.comments !== 1 ? 's' : ''}
                </p>
              </div>
              <div className="flex flex-col gap-2 shrink-0">
                <button
                  onClick={() => setEditingPost(post)}
                  className="text-xs user-card border px-3 py-1.5 rounded-lg transition-colors" style={{ borderColor: 'var(--user-border-color)' }}
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(post.id)}
                  className="text-xs border border-red-900/50 text-red-400 hover:bg-red-900/20 px-3 py-1.5 rounded-lg transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {nextCursor && !loading && (
        <div className="text-center mt-4">
          <button
            onClick={() => loadPosts(query, nextCursor)}
            className="user-card border px-6 py-2 rounded-lg text-sm" style={{ borderColor: "var(--user-border-color)" }}
          >
            Load more
          </button>
        </div>
      )}

      {editingPost && (
        <EditPostModal
          post={editingPost}
          token={token}
          onClose={() => setEditingPost(null)}
          onSaved={() => { setEditingPost(null); loadPosts(query); }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Creators panel
// ---------------------------------------------------------------------------

function CreatorsPanel({ token }: { token: string | null }) {
  const [creators, setCreators] = useState<AdminCreator[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCreators = useCallback(async (cursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL(`${BACKEND}/api/v1/creators`);
      url.searchParams.set('limit', '20');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url.toString());
      const data = await res.json() as { creators: AdminCreator[]; nextCursor: string | null };
      setCreators((c) => cursor ? [...c, ...data.creators] : data.creators);
      setNextCursor(data.nextCursor);
    } catch {
      setError('Failed to load creators');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadCreators(); }, [loadCreators]);

  const handleDelete = async (creatorId: string) => {
    if (!confirm('Permanently delete this creator and ALL their posts?')) return;
    try {
      const res = await fetch(`${BACKEND}/api/v1/admin/creators/${creatorId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
      if (!res.ok) {
        const d = await res.json() as { error: string };
        setError(d.error ?? 'Delete failed');
        return;
      }
      setCreators((c) => c.filter((cr) => cr.id !== creatorId));
    } catch {
      setError('Network error');
    }
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Creators</h2>
      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
      {loading && <p className="text-gray-500 text-sm">Loading…</p>}

      {!loading && creators.length === 0 && (
        <p className="text-gray-500 text-sm">No creators found.</p>
      )}

      <div className="space-y-2">
        {creators.map((cr) => (
          <div key={cr.id} className="user-card border rounded-xl px-4 py-3 flex items-center gap-4" style={{ borderColor: 'var(--user-border-color)' }}>
            <div className="flex-1 min-w-0">
              <Link
                href={`/${cr.serviceType}/user/${cr.externalId}`}
                className="font-medium text-white hover:text-indigo-300 transition-colors truncate block"
              >
                {cr.name ?? cr.externalId}
              </Link>
              <p className="text-xs text-gray-500 mt-0.5">
                {cr.serviceType} · {cr._count.posts} post{cr._count.posts !== 1 ? 's' : ''}
              </p>
            </div>
            <button
              onClick={() => handleDelete(cr.id)}
              className="text-xs border border-red-900/50 text-red-400 hover:bg-red-900/20 px-3 py-1.5 rounded-lg transition-colors shrink-0"
            >
              Delete
            </button>
          </div>
        ))}
      </div>

      {nextCursor && !loading && (
        <div className="text-center mt-4">
          <button
            onClick={() => loadCreators(nextCursor)}
            className="user-card border px-6 py-2 rounded-lg text-sm" style={{ borderColor: "var(--user-border-color)" }}
          >
            Load more
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Importers panel
// ---------------------------------------------------------------------------

interface ImporterRow {
  id: string;
  enabled: boolean;
}

function ImportersPanel({ token }: { token: string | null }) {
  const [importers, setImporters] = useState<ImporterRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`${BACKEND}/api/v1/admin/importers`, { headers: authHeaders(token) })
      .then((r) => r.json())
      .then((d) => setImporters(d.importers ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  const toggle = async (id: string, current: boolean) => {
    setToggling(id);
    try {
      const res = await fetch(`${BACKEND}/api/v1/admin/importers/${id}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ enabled: !current }),
      });
      if (res.ok) {
        setImporters((prev) => prev.map((imp) => imp.id === id ? { ...imp, enabled: !current } : imp));
      }
    } finally {
      setToggling(null);
    }
  };

  if (loading) return <p className="text-gray-500 text-sm">Loading…</p>;

  return (
    <section>
      <h2 className="text-lg font-semibold mb-1">Importers</h2>
      <p className="text-sm text-gray-400 mb-4">Enable or disable which importers are available to users.</p>
      <div className="user-section-bg rounded-xl divide-y" style={{ borderColor: 'var(--user-border-color)' }}>
        {importers.map((imp) => (
          <div key={imp.id} className="flex items-center justify-between px-4 py-3 gap-2">
            <span className="text-sm font-medium capitalize">{imp.id}</span>
            <button
              onClick={() => toggle(imp.id, imp.enabled)}
              disabled={toggling === imp.id}
              className={`shrink-0 px-3 py-1 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                imp.enabled
                  ? 'bg-green-600/30 text-green-300 hover:bg-green-600/50'
                  : 'user-sidebar-bg opacity-60'
              }`}
            >
              {toggling === imp.id ? '…' : imp.enabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main admin page
// ---------------------------------------------------------------------------

export default function AdminPage() {
  const { user, token, loading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('posts');

  useEffect(() => {
    if (!loading && (!user || !user.isAdmin)) {
      router.replace('/');
    }
  }, [loading, user, router]);

  if (loading) {
    return (
      <main className="min-h-[calc(100vh-3rem)] user-bg flex items-center justify-center">
        <p className="text-gray-500">Loading…</p>
      </main>
    );
  }

  if (!user?.isAdmin) return null;

  const TAB_LABELS: Record<Tab, string> = {
    posts: 'Posts',
    tags: 'Tags',
    creators: 'Creators',
    jobs: 'Jobs',
    channels: 'Channels',
    importers: 'Importers',
  };

  return (
    <main className="min-h-[calc(100vh-3rem)] user-bg p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Admin Panel</h1>

        {/* Tab bar */}
        <div className="flex flex-wrap gap-1 border-b mb-6" style={{ borderColor: 'var(--user-border-color)' }}>
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${
                tab === t
                  ? 'border-[var(--user-btn-color)]'
                  : 'border-transparent opacity-50 hover:opacity-100'
              }`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {tab === 'posts' && <PostsPanel token={token} />}
        {tab === 'tags' && <TagsPanel token={token} />}
        {tab === 'creators' && <CreatorsPanel token={token} />}
        {tab === 'jobs' && <JobsPanel token={token} />}
        {tab === 'channels' && <ChannelsPanel token={token} />}
        {tab === 'importers' && <ImportersPanel token={token} />}
      </div>
    </main>
  );
}
