import DiscordServerView from '@/components/DiscordServerView';
import Link from 'next/link';

interface Props {
  params: Promise<{ serverId: string }>;
}

export default async function DiscordServerPage({ params }: Props) {
  const { serverId } = await params;

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 3rem)' }}>
      {/* Breadcrumb strip */}
      <div className="shrink-0 h-8 flex items-center px-4 gap-2 user-section-bg border-b border-gray-800 text-xs text-gray-500">
        <Link href="/discord/servers" className="hover:text-gray-300 transition-colors">
          Discord Servers
        </Link>
        <span>/</span>
        <span className="text-gray-400">Server</span>
      </div>

      {/* Full-height server layout */}
      <div className="flex-1 min-h-0">
        <DiscordServerView serverId={serverId} />
      </div>
    </div>
  );
}
