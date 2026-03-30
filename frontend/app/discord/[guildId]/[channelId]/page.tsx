import DiscordGuildView from '@/components/DiscordGuildView';
import Link from 'next/link';

interface Props {
  params: Promise<{ guildId: string; channelId: string }>;
}

export default async function DiscordChannelPage({ params }: Props) {
  const { guildId, channelId } = await params;

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 3rem)' }}>
      {/* Breadcrumb strip */}
      <div className="shrink-0 h-8 flex items-center px-4 gap-2 bg-gray-900 border-b border-gray-800 text-xs text-gray-500">
        <Link href="/discord" className="hover:text-gray-300 transition-colors">
          Discord
        </Link>
        <span>/</span>
        <Link href={`/discord/${guildId}`} className="hover:text-gray-300 transition-colors">
          Guild {guildId}
        </Link>
        <span>/</span>
        <span className="text-gray-400">Channel {channelId}</span>
      </div>

      {/* Full-height guild layout with channel pre-selected */}
      <div className="flex-1 min-h-0">
        <DiscordGuildView guildId={guildId} activeChannelId={channelId} />
      </div>
    </div>
  );
}
