import PostsList from '@/components/PostsList';
import Link from 'next/link';

interface Props {
  params: Promise<{ creatorId: string }>;
}

export default async function CreatorPostsPage({ params }: Props) {
  const { creatorId } = await params;

  return (
    <div className="min-h-[calc(100vh-3rem)] bg-gray-950 text-white">
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Posts</h1>
          <Link
            href="/creators"
            className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            ← Back to Artists
          </Link>
        </div>
        <PostsList creatorId={creatorId} />
      </div>
    </div>
  );
}
