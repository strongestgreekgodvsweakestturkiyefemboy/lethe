'use client';

import { useState, useEffect } from 'react';
import { useAuth } from './AuthContext';

const BACKEND = '';
const LS_PREFS_KEY = 'lethe_prefs';

const inputClass =
  'w-full user-input border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--user-btn-color)]';

export interface Preferences {
  fontSize: number;
  fontFamily: string;
  bgColor: string;
  fontColor: string;
  accentColor: string;
  contentBgColor: string;
  contentTextColor: string;
  contentFontFamily: string;
  contentFontSize: number;
}

export const DEFAULT_PREFS: Preferences = {
  fontSize: 14,
  fontFamily: 'sans-serif',
  bgColor: '#030712',
  fontColor: '#ffffff',
  accentColor: '#111827',
  contentBgColor: '#1f2937',
  contentTextColor: '#e5e7eb',
  contentFontFamily: 'sans-serif',
  contentFontSize: 14,
};

const THEME_PRESETS = [
  { label: 'Dark (default)', bgColor: '#030712' },
  { label: 'Light', bgColor: '#f9fafb' },
  { label: 'Sepia', bgColor: '#fdf6e3' },
  { label: 'Dim', bgColor: '#1a1a2e' },
];

const FONT_OPTIONS = [
  { value: 'sans-serif', label: 'Sans-serif (default)' },
  { value: 'serif', label: 'Serif' },
  { value: 'monospace', label: 'Monospace' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: "'Courier New', monospace", label: 'Courier New' },
];

// ── Colour utilities ──────────────────────────────────────────────────────────

function hexToHsl(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return [0, 0, 0];
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h: number, s: number, l: number): string {
  const hNorm = (((h % 360) + 360) % 360) / 360;
  const sNorm = Math.max(0, Math.min(100, s)) / 100;
  const lNorm = Math.max(0, Math.min(100, l)) / 100;
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  let r: number;
  let g: number;
  let b: number;
  if (sNorm === 0) {
    r = g = b = lNorm;
  } else {
    const q = lNorm < 0.5 ? lNorm * (1 + sNorm) : lNorm + sNorm - lNorm * sNorm;
    const p = 2 * lNorm - q;
    r = hue2rgb(p, q, hNorm + 1 / 3);
    g = hue2rgb(p, q, hNorm);
    b = hue2rgb(p, q, hNorm - 1 / 3);
  }
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function clampN(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Compute a slightly lighter (dark bg) or darker (light bg) offset of a hex colour. */
function offsetBgColor(hex: string): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return hex;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const delta = luminance < 0.5 ? 20 : -20;
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  const nr = clamp(r + delta);
  const ng = clamp(g + delta);
  const nb = clamp(b + delta);
  return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
}

/**
 * Generate a full Preferences palette from a single background colour.
 * All site-chrome and content colours are derived automatically.
 */
export function paletteFromBg(bgColor: string): Preferences {
  const [h, s, l] = hexToHsl(bgColor);
  const isDark = l < 50;

  if (isDark) {
    return {
      ...DEFAULT_PREFS,
      bgColor,
      fontColor: '#f0f0f0',
      accentColor: hslToHex(h, s, clampN(l + 8, 0, 90)),
      contentBgColor: hslToHex(h, s, clampN(l + 12, 0, 90)),
      contentTextColor: '#d4d4d4',
    };
  } else {
    return {
      ...DEFAULT_PREFS,
      bgColor,
      fontColor: '#1a1a1a',
      accentColor: hslToHex(h, s, clampN(l - 12, 5, 95)),
      contentBgColor: hslToHex(h, clampN(s * 0.4, 0, 100), clampN(l + 3, 5, 98)),
      contentTextColor: '#1a1a1a',
    };
  }
}

export function applyPrefs(prefs: Preferences) {
  const el = document.documentElement.style;
  el.setProperty('--user-font-size', `${prefs.fontSize}px`);
  el.setProperty('--user-font-family', prefs.fontFamily);
  el.setProperty('--user-bg-color', prefs.bgColor);
  el.setProperty('--user-bg-secondary', offsetBgColor(prefs.bgColor));
  el.setProperty('--user-font-color', prefs.fontColor);
  el.setProperty('--user-accent-color', prefs.accentColor);
  el.setProperty('--user-content-bg-color', prefs.contentBgColor);
  el.setProperty('--user-content-text-color', prefs.contentTextColor);
  el.setProperty('--user-content-font-family', prefs.contentFontFamily);
  el.setProperty('--user-content-font-size', `${prefs.contentFontSize}px`);

  // Derive card/button/border colours from the background colour
  const [h, s, l] = hexToHsl(prefs.bgColor);
  const isDark = l < 50;
  // For very low-saturation backgrounds, fall back to indigo (239°) for buttons
  const btnHue = s < 15 ? 239 : h;
  const btnSat = clampN(Math.max(s, 55), 50, 85);

  const cardBg = isDark
    ? hslToHex(h, s, clampN(l + 10, 0, 90))
    : hslToHex(h, clampN(s * 0.3, 0, 100), clampN(l - 3, 5, 100));
  const cardHoverBg = isDark
    ? hslToHex(h, s, clampN(l + 17, 0, 90))
    : hslToHex(h, clampN(s * 0.3, 0, 100), clampN(l - 8, 5, 100));
  const borderColor = isDark
    ? hslToHex(h, s, clampN(l + 15, 0, 90))
    : hslToHex(h, clampN(s * 0.2, 0, 100), clampN(l - 15, 5, 100));
  const btnColor = hslToHex(btnHue, btnSat, isDark ? 55 : 42);
  const btnHoverColor = hslToHex(btnHue, btnSat, isDark ? 65 : 35);

  el.setProperty('--user-card-bg', cardBg);
  el.setProperty('--user-card-hover-bg', cardHoverBg);
  el.setProperty('--user-btn-color', btnColor);
  el.setProperty('--user-btn-hover-color', btnHoverColor);
  el.setProperty('--user-border-color', borderColor);
}

export function loadLocalPrefs(): Preferences {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(LS_PREFS_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_PREFS;
}

function ColorField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1" style={{ color: 'var(--user-font-color)', opacity: 0.8 }}>{label}</label>
      <div className="flex gap-2 items-center">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="w-10 h-10 rounded cursor-pointer border-0 bg-transparent shrink-0" />
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className={`${inputClass} flex-1`} placeholder={placeholder} />
      </div>
    </div>
  );
}

function SectionHeader({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between text-xs font-semibold uppercase tracking-wider mb-2 py-1 transition-opacity hover:opacity-80"
      style={{ color: 'var(--user-font-color)', opacity: 0.5 }}
    >
      <span>{label}</span>
      <svg
        className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`}
        fill="none" stroke="currentColor" viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  );
}

export default function PreferencesModal({ onClose }: { onClose: () => void }) {
  const { token } = useAuth();
  const [prefs, setPrefs] = useState<Preferences>(() => loadLocalPrefs());
  const [loading, setLoading] = useState(false);
  const [showSite, setShowSite] = useState(false);
  const [showContent, setShowContent] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch(`${BACKEND}/api/v1/users/preferences`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d) => {
        if (d.preferences) {
          const merged = { ...DEFAULT_PREFS, ...d.preferences };
          setPrefs(merged);
          applyPrefs(merged);
        }
      })
      .catch(() => {});
  }, [token]);

  /** When the base colour changes, auto-derive all other palette colours. */
  const handleBaseColorChange = (color: string) => {
    const derived = paletteFromBg(color);
    setPrefs((p) => ({
      ...derived,
      fontSize: p.fontSize,
      fontFamily: p.fontFamily,
      contentFontFamily: p.contentFontFamily,
      contentFontSize: p.contentFontSize,
    }));
  };

  const handleSave = async () => {
    setLoading(true);
    localStorage.setItem(LS_PREFS_KEY, JSON.stringify(prefs));
    applyPrefs(prefs);
    if (token) {
      try {
        await fetch(`${BACKEND}/api/v1/users/preferences`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(prefs),
        });
      } catch { /* ignore */ }
    }
    window.location.reload();
  };

  const modalBg = { backgroundColor: 'var(--user-card-bg)', color: 'var(--user-font-color)' };
  const borderStyle = { borderColor: 'var(--user-border-color)' };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto border"
        style={{ ...modalBg, ...borderStyle }}
      >
        <h2 className="text-xl font-bold mb-5">Display Preferences</h2>

        {/* Theme presets */}
        <div className="mb-5">
          <label className="block text-sm font-medium mb-2" style={{ opacity: 0.7 }}>Quick Presets</label>
          <div className="grid grid-cols-2 gap-2">
            {THEME_PRESETS.map((preset) => {
              const isActive = prefs.bgColor === preset.bgColor;
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => handleBaseColorChange(preset.bgColor)}
                  className="px-3 py-2 rounded-lg border text-sm transition-colors"
                  style={isActive
                    ? { borderColor: 'var(--user-btn-color)', backgroundColor: 'color-mix(in srgb, var(--user-btn-color) 20%, transparent)', color: 'var(--user-btn-hover-color)' }
                    : { ...borderStyle, color: 'var(--user-font-color)' }}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Base colour */}
        <div className="mb-5">
          <ColorField
            label="Base colour (auto-generates full palette)"
            value={prefs.bgColor}
            onChange={handleBaseColorChange}
            placeholder="#030712"
          />
        </div>

        {/* Font */}
        <div className="mb-5 space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ opacity: 0.7 }}>Font</label>
            <select
              value={prefs.fontFamily}
              onChange={(e) => setPrefs((p) => ({ ...p, fontFamily: e.target.value }))}
              className={`${inputClass} border`}
            >
              {FONT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" style={{ opacity: 0.7 }}>Size (px)</label>
            <input
              type="number" min={10} max={32} value={prefs.fontSize}
              onChange={(e) => setPrefs((p) => ({ ...p, fontSize: Number(e.target.value) }))}
              className={`${inputClass} border`}
            />
          </div>
        </div>

        {/* Site colours — collapsible */}
        <div className="mb-3 border rounded-lg px-3 py-2" style={borderStyle}>
          <SectionHeader label="Site colours" open={showSite} onToggle={() => setShowSite((v) => !v)} />
          {showSite && (
            <div className="space-y-3 pt-1 pb-1">
              <ColorField label="Background" value={prefs.bgColor} onChange={(v) => setPrefs((p) => ({ ...p, bgColor: v }))} placeholder="#030712" />
              <ColorField label="Navbar" value={prefs.accentColor} onChange={(v) => setPrefs((p) => ({ ...p, accentColor: v }))} placeholder="#111827" />
              <ColorField label="Text" value={prefs.fontColor} onChange={(v) => setPrefs((p) => ({ ...p, fontColor: v }))} placeholder="#ffffff" />
            </div>
          )}
        </div>

        {/* Content colours — collapsible */}
        <div className="mb-5 border rounded-lg px-3 py-2" style={borderStyle}>
          <SectionHeader label="Content colours" open={showContent} onToggle={() => setShowContent((v) => !v)} />
          {showContent && (
            <div className="space-y-3 pt-1 pb-1">
              <ColorField label="Background" value={prefs.contentBgColor} onChange={(v) => setPrefs((p) => ({ ...p, contentBgColor: v }))} placeholder="#1f2937" />
              <ColorField label="Text" value={prefs.contentTextColor} onChange={(v) => setPrefs((p) => ({ ...p, contentTextColor: v }))} placeholder="#e5e7eb" />
              <div>
                <label className="block text-sm font-medium mb-1" style={{ opacity: 0.7 }}>Font</label>
                <select
                  value={prefs.contentFontFamily}
                  onChange={(e) => setPrefs((p) => ({ ...p, contentFontFamily: e.target.value }))}
                  className={`${inputClass} border`}
                >
                  {FONT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" style={{ opacity: 0.7 }}>Size (px)</label>
                <input
                  type="number" min={10} max={32} value={prefs.contentFontSize}
                  onChange={(e) => setPrefs((p) => ({ ...p, contentFontSize: Number(e.target.value) }))}
                  className={`${inputClass} border`}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <button
            onClick={onClose}
            className="flex-1 border rounded-lg py-2 text-sm font-medium transition-opacity hover:opacity-80"
            style={{ ...borderStyle, color: 'var(--user-font-color)' }}
          >
            Close
          </button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="flex-1 user-btn rounded-lg py-2 font-semibold"
          >
            {loading ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
