'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from './AuthContext';

const BACKEND = '';

interface Props {
  creatorId: string;
}

export default function FavoriteButton({ creatorId }: Props) {
  const { user, token } = useAuth();
  const [favorited, setFavorited] = useState(false);
  const [loading, setLoading] = useState(false);

  // Check if already favorited on mount
  useEffect(() => {
    if (!token || !creatorId) return;
    fetch(`${BACKEND}/api/v1/favorites`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data: { favorites: { id: string }[] }) => {
        setFavorited(data.favorites.some((c) => c.id === creatorId));
      })
      .catch(() => {});
  }, [token, creatorId]);

  const toggle = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      if (favorited) {
        await fetch(`${BACKEND}/api/v1/favorites/${creatorId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        setFavorited(false);
      } else {
        await fetch(`${BACKEND}/api/v1/favorites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ creatorId }),
        });
        setFavorited(true);
      }
    } finally {
      setLoading(false);
    }
  }, [token, creatorId, favorited]);

  if (!user) return null;

  return (
    <button
      onClick={toggle}
      disabled={loading}
      title={favorited ? 'Remove from favourites' : 'Add to favourites'}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
        favorited
          ? 'bg-pink-600/20 text-pink-400 hover:bg-pink-600/30 border border-pink-600/30'
          : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600'
      }`}
    >
      <svg
        className="w-4 h-4"
        fill={favorited ? 'currentColor' : 'none'}
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
        />
      </svg>
      {favorited ? 'Favourited' : 'Favourite'}
    </button>
  );
}
