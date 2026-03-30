'use client';

import { useEffect } from 'react';
import { loadLocalPrefs, applyPrefs } from './PreferencesModal';

/**
 * Invisible component that applies saved display preferences on initial page load.
 * Must be rendered inside the document body so CSS variables propagate immediately.
 */
export default function ThemeInitializer() {
  useEffect(() => {
    applyPrefs(loadLocalPrefs());
  }, []);
  return null;
}
