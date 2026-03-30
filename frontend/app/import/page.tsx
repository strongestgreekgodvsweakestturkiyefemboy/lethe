import ImportForm from '@/components/ImportForm';

export default function ImportPage() {
  return (
    <main className="min-h-[calc(100vh-3rem)] user-bg flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <h1 className="text-3xl font-bold mb-8 text-center">Import Data</h1>
        <ImportForm />
      </div>
    </main>
  );
}
