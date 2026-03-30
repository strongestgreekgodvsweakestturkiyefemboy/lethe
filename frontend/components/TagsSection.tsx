'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from './AuthContext';
import siteConfig from '@/site.config';

const BACKEND_URL = '';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImporterTag {
  tag: { id: string; name: string };
}

export interface UserTag {
  tag: { id: string; name: string };
  addedByMe: boolean;
}

type EntityType = 'post' | 'creator' | 'discordServer';

interface Props {
  entityType: EntityType;
  entityId: string;
  /** Importer/admin-managed tags (PostTag entries). Only relevant for posts. */
  importerTags?: ImporterTag[];
  /** Pre-fetched user tags (already in the entity response). Pass undefined to fetch lazily. */
  initialUserTags?: UserTag[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entityPath(entityType: EntityType, entityId: string): string {
  switch (entityType) {
    case 'post': return `/api/v1/posts/${entityId}/tags`;
    case 'creator': return `/api/v1/creators/${entityId}/tags`;
    case 'discordServer': return `/api/v1/discord/servers/${entityId}/tags`;
  }
}

function authHeaders(token: string | null): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// ---------------------------------------------------------------------------
// TagsSection component
// ---------------------------------------------------------------------------

/**
 * Displays importer-managed tags and user-added tags for a post, creator, or
 * Discord server. When the user is logged in they can add / remove their own tags.
 *
 * Label convention:
 *   - Importer tags → "Importer Tags"
 *   - User tags     → "{siteName} User Tags"
 */
export default function TagsSection({
  entityType,
  entityId,
  importerTags,
  initialUserTags,
}: Props) {
  const { user, token } = useAuth();

  const siteName = siteConfig.siteName;
  const [userTags, setUserTags] = useState<UserTag[]>(initialUserTags ?? []);
  const [inputValue, setInputValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch user tags if not provided (e.g. for creator / discord server pages that
  // don't bundle them in the main response yet).
  const fetchUserTags = useCallback(async () => {
    if (entityType === 'post') return; // post page already provides initialUserTags
    try {
      const res = await fetch(`${BACKEND_URL}${entityPath(entityType, entityId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json() as { userTags: UserTag[] };
        setUserTags(data.userTags ?? []);
      }
    } catch { /* best effort */ }
  }, [entityType, entityId, token]);

  useEffect(() => {
    if (initialUserTags === undefined) {
      void fetchUserTags();
    }
  }, [initialUserTags, fetchUserTags]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = inputValue.trim();
    if (!name || !token) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${BACKEND_URL}${entityPath(entityType, entityId)}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        let errorMsg = 'Failed to add tag';
        try {
          const data = await res.json() as { error?: string };
          errorMsg = data.error ?? errorMsg;
        } catch { /* response was not JSON */ }
        setError(errorMsg);
        return;
      }
      const data = await res.json() as { tag?: { tag: { id: string; name: string } } };
      setInputValue('');
      // For posts we can optimistically update from the returned tag data;
      // for other entity types re-fetch to get the deduplicated list.
      if (entityType === 'post' && data.tag?.tag) {
        const newTag = data.tag.tag;
        setUserTags((prev) => {
          if (prev.some((t) => t.tag.id === newTag.id)) return prev;
          return [...prev, { tag: newTag, addedByMe: true }].sort((a, b) =>
            a.tag.name.localeCompare(b.tag.name),
          );
        });
      } else {
        await fetchUserTags();
      }
    } catch {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (tagId: string) => {
    if (!token) return;
    try {
      await fetch(`${BACKEND_URL}${entityPath(entityType, entityId)}/${tagId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
      setUserTags((prev) => {
        const updated = prev.filter((t) => !(t.tag.id === tagId && t.addedByMe));
        // If someone else also tagged it, keep it but mark as not mine
        return updated;
      });
    } catch { /* best effort */ }
  };

  const hasImporterTags = importerTags && importerTags.length > 0;
  const hasUserTags = userTags.length > 0;

  if (!hasImporterTags && !hasUserTags && !user) return null;

  return (
    <div className="space-y-3">
      {/* Importer Tags */}
      {hasImporterTags && (
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-1.5">Importer Tags</p>
          <div className="flex flex-wrap gap-1.5">
            {importerTags!.map((pt) => (
              <span
                key={pt.tag.id}
                className="text-xs bg-gray-700/60 text-gray-300 px-2 py-0.5 rounded-full border border-gray-600"
              >
                {pt.tag.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* User Tags */}
      {(hasUserTags || user) && (
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-1.5">
            {siteName} User Tags
          </p>
          {hasUserTags && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {userTags.map((ut) => (
                <span
                  key={ut.tag.id}
                  className="flex items-center gap-1 text-xs bg-indigo-900/50 text-indigo-300 px-2 py-0.5 rounded-full border border-indigo-800/50"
                >
                  {ut.tag.name}
                  {ut.addedByMe && (
                    <button
                      onClick={() => handleRemove(ut.tag.id)}
                      className="text-indigo-400 hover:text-red-400 transition-colors ml-0.5 leading-none"
                      title="Remove your tag"
                      aria-label={`Remove tag ${ut.tag.name}`}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}

          {/* Add-tag form (logged-in users only) */}
          {user && (
            <form onSubmit={handleAdd} className="flex gap-2">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Add a tag…"
                maxLength={64}
                className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                type="submit"
                disabled={submitting || !inputValue.trim()}
                className="shrink-0 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg px-3 py-1 transition-colors"
              >
                {submitting ? '…' : '+ Tag'}
              </button>
            </form>
          )}
          {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
        </div>
      )}
    </div>
  );
}
