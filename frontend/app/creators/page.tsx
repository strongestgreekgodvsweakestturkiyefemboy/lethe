'use client';

import { Suspense, useState } from 'react';
import CreatorsGallery from '@/components/CreatorsGallery';

const SITES = ['', 'kemono', 'patreon', 'fanbox', 'gumroad', 'subscribestar', 'onlyfans', 'fansly', 'boosty', 'dlsite', 'fantia'];
const SERVICE_TYPES = ['', 'patreon', 'fanbox', 'gumroad', 'subscribestar', 'onlyfans', 'fansly', 'boosty', 'dlsite', 'fantia'];

function CreatorsPageContent() {
  const [sourceSite, setSourceSite] = useState('');
  const [serviceType, setServiceType] = useState('');
  const [appliedSite, setAppliedSite] = useState('');
  const [appliedType, setAppliedType] = useState('');

  const applyFilters = () => {
    setAppliedSite(sourceSite);
    setAppliedType(serviceType);
  };

  return (
    <div className="min-h-[calc(100vh-3rem)] user-bg">
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
        <h1 className="text-2xl font-bold">Artists</h1>

        <div className="user-section-bg rounded-xl p-4 flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs" htmlFor="site" style={{ opacity: 0.6 }}>Importer</label>
            <select
              id="site"
              value={sourceSite}
              onChange={(e) => setSourceSite(e.target.value)}
              className="user-input border rounded-lg px-3 py-1.5 text-sm focus:outline-none"
            >
              {SITES.map((s) => <option key={s} value={s}>{s || 'All importers'}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs" htmlFor="svctype" style={{ opacity: 0.6 }}>Service</label>
            <select
              id="svctype"
              value={serviceType}
              onChange={(e) => setServiceType(e.target.value)}
              className="user-input border rounded-lg px-3 py-1.5 text-sm focus:outline-none"
            >
              {SERVICE_TYPES.map((t) => <option key={t} value={t}>{t || 'All services'}</option>)}
            </select>
          </div>

          <button
            onClick={applyFilters}
            className="user-btn rounded-lg px-4 py-1.5 text-sm font-medium"
          >
            Apply
          </button>
        </div>

        <CreatorsGallery sourceSite={appliedSite || undefined} serviceType={appliedType || undefined} />
      </div>
    </div>
  );
}

export default function CreatorsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[calc(100vh-3rem)] user-bg flex items-center justify-center">
          Loading…
        </div>
      }
    >
      <CreatorsPageContent />
    </Suspense>
  );
}

export { SITES, SERVICE_TYPES };
