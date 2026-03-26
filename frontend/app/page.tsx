import Link from 'next/link';
import LatestSection from '@/components/LatestSection';

export default function HomePage() {
  return (
    <main className="min-h-[calc(100vh-3rem)] bg-gray-950 text-white p-6">
      <div className="max-w-6xl mx-auto space-y-12">
        {/* Hero */}
        <div className="text-center py-12">
          <h1 className="text-4xl font-bold mb-4">Lethe</h1>
          <p className="text-gray-400 text-lg mb-8">Self-hosted data archival service</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href="/import"
              className="bg-indigo-600 hover:bg-indigo-500 px-6 py-2.5 rounded-lg font-semibold transition-colors"
            >
              Start Import
            </Link>
            <Link
              href="/creators"
              className="border border-gray-700 hover:bg-gray-800 px-6 py-2.5 rounded-lg font-semibold transition-colors"
            >
              Browse Artists
            </Link>
            <Link
              href="/search"
              className="border border-gray-700 hover:bg-gray-800 px-6 py-2.5 rounded-lg font-semibold transition-colors"
            >
              Search
            </Link>
          </div>
        </div>

        {/* Latest content */}
        <LatestSection />
      </div>
    </main>
  );
}
