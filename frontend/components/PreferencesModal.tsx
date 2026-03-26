'use client';

import { useState, useEffect } from 'react';
import { useAuth } from './AuthContext';

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001';

const inputClass =
  'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500';

interface Preferences {
  fontSize: number;
  fontFamily: string;
  bgColor: string;
  fontColor: string;
}

const FONT_OPTIONS = [
  { value: 'sans-serif', label: 'Sans-serif (default)' },
  { value: 'serif', label: 'Serif' },
  { value: 'monospace', label: 'Monospace' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: "'Courier New', monospace", label: 'Courier New' },
];

export default function PreferencesModal({ onClose }: { onClose: () => void }) {
  const { token } = useAuth();
  const [prefs, setPrefs] = useState<Preferences>({
    fontSize: 14,
    fontFamily: 'sans-serif',
    bgColor: '#030712',
    fontColor: '#ffffff',
  });
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch(`${BACKEND}/api/v1/users/preferences`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => { if (d.preferences) setPrefs(d.preferences); })
      .catch(() => {});
  }, [token]);

  const handleSave = async () => {
    if (!token) return;
    setLoading(true);
    setSaved(false);
    try {
      const res = await fetch(`${BACKEND}/api/v1/users/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(prefs),
      });
      if (res.ok) {
        const data = await res.json() as { preferences: Preferences };
        setPrefs(data.preferences);
        // Apply preferences immediately
        document.documentElement.style.setProperty('--user-font-size', `${data.preferences.fontSize}px`);
        document.documentElement.style.setProperty('--user-font-family', data.preferences.fontFamily);
        document.documentElement.style.setProperty('--user-bg-color', data.preferences.bgColor);
        document.documentElement.style.setProperty('--user-font-color', data.preferences.fontColor);
        setSaved(true);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 w-full max-w-sm shadow-2xl">
        <h2 className="text-xl font-bold mb-6 text-white">Display Preferences</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1 text-gray-300">Font size (px)</label>
            <input
              type="number"
              min={10}
              max={32}
              value={prefs.fontSize}
              onChange={(e) => setPrefs((p) => ({ ...p, fontSize: Number(e.target.value) }))}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-gray-300">Font family</label>
            <select
              value={prefs.fontFamily}
              onChange={(e) => setPrefs((p) => ({ ...p, fontFamily: e.target.value }))}
              className={inputClass}
            >
              {FONT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-gray-300">Background color</label>
            <div className="flex gap-2 items-center">
              <input
                type="color"
                value={prefs.bgColor}
                onChange={(e) => setPrefs((p) => ({ ...p, bgColor: e.target.value }))}
                className="w-10 h-10 rounded cursor-pointer border-0 bg-transparent"
              />
              <input
                type="text"
                value={prefs.bgColor}
                onChange={(e) => setPrefs((p) => ({ ...p, bgColor: e.target.value }))}
                className={`${inputClass} flex-1`}
                placeholder="#030712"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-gray-300">Font color</label>
            <div className="flex gap-2 items-center">
              <input
                type="color"
                value={prefs.fontColor}
                onChange={(e) => setPrefs((p) => ({ ...p, fontColor: e.target.value }))}
                className="w-10 h-10 rounded cursor-pointer border-0 bg-transparent"
              />
              <input
                type="text"
                value={prefs.fontColor}
                onChange={(e) => setPrefs((p) => ({ ...p, fontColor: e.target.value }))}
                className={`${inputClass} flex-1`}
                placeholder="#ffffff"
              />
            </div>
          </div>
          {saved && <p className="text-green-400 text-sm">Preferences saved!</p>}
          <div className="flex gap-2 pt-2">
            <button
              onClick={onClose}
              className="flex-1 border border-gray-700 hover:bg-gray-800 rounded-lg py-2 text-sm font-medium transition-colors"
            >
              Close
            </button>
            <button
              onClick={handleSave}
              disabled={loading}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg py-2 font-semibold transition-colors"
            >
              {loading ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
