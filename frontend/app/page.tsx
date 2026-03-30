import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="min-h-[calc(100vh-3rem)] user-bg p-6">
      <div className="max-w-6xl mx-auto space-y-12">
        {/* Hero */}
        <div className="text-center py-12">
          <h1 className="text-4xl font-bold mb-4">Lethe</h1>
          <p className="text-lg mb-8" style={{ opacity: 0.5 }}>Self-hosted data archival service</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href="/import"
              className="user-btn px-6 py-2.5 rounded-lg font-semibold"
            >
              Start Import
            </Link>
            <Link
              href="/creators"
              className="user-card border px-6 py-2.5 rounded-lg font-semibold"
              style={{ borderColor: 'var(--user-border-color)' }}
            >
              Browse Artists
            </Link>
            <Link
              href="/search"
              className="user-card border px-6 py-2.5 rounded-lg font-semibold"
              style={{ borderColor: 'var(--user-border-color)' }}
            >
              Search
            </Link>
            <Link
              href="/posts"
              className="user-card border px-6 py-2.5 rounded-lg font-semibold"
              style={{ borderColor: 'var(--user-border-color)' }}
            >
              Browse Posts
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
