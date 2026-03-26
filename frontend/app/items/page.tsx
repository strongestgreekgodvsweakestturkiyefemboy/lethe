'use client';

import { Suspense, useState } from 'react';
import ItemsGallery from '@/components/ItemsGallery';

const SITES = ['', 'kemono', 'patreon', 'fanbox', 'gumroad', 'subscribestar', 'onlyfans', 'fansly', 'boosty', 'dlsite', 'discord', 'fantia', 'site_a', 'lethe_peer'];
const DATA_TYPES = ['', 'TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'FILE'];

function ItemsPageContent() {
  const [sourceSite, setSourceSite] = useState('');
  const [dataType, setDataType] = useState('');
  const [appliedSite, setAppliedSite] = useState('');
  const [appliedType, setAppliedType] = useState('');

  const applyFilters = () => {
    setAppliedSite(sourceSite);
    setAppliedType(dataType);
  };

  return (
    <div className="min-h-[calc(100vh-3rem)] bg-gray-950 text-white">
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
        <h1 className="text-2xl font-bold">Imported Items</h1>

        <div className="bg-gray-900 rounded-xl p-4 flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400" htmlFor="site">Site</label>
            <select
              id="site"
              value={sourceSite}
              onChange={(e) => setSourceSite(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {SITES.map((s) => <option key={s} value={s}>{s || 'All sites'}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400" htmlFor="type">Type</label>
            <select
              id="type"
              value={dataType}
              onChange={(e) => setDataType(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {DATA_TYPES.map((t) => <option key={t} value={t}>{t || 'All types'}</option>)}
            </select>
          </div>

          <button
            onClick={applyFilters}
            className="bg-indigo-600 hover:bg-indigo-500 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors"
          >
            Apply
          </button>
        </div>

        <ItemsGallery sourceSite={appliedSite || undefined} dataType={appliedType || undefined} />
      </div>
    </div>
  );
}

export default function ItemsPage() {
  return (
    <Suspense fallback={<div className="min-h-[calc(100vh-3rem)] bg-gray-950 text-white flex items-center justify-center">Loading…</div>}>
      <ItemsPageContent />
    </Suspense>
  );
}
