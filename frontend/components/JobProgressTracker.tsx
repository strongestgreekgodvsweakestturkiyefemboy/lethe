'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

interface JobUpdate {
  status: string;
  progressPct: number;
  connected?: boolean;
  jobId?: string;
  logMessage?: string;
}

interface Props {
  jobId: string;
  onReset: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'text-yellow-400',
  IN_PROGRESS: 'text-blue-400',
  COMPLETED: 'text-green-400',
  FAILED: 'text-red-400',
  FAILED_RATE_LIMIT: 'text-orange-400',
};

const MAX_LOG_LINES = 200;

export default function JobProgressTracker({ jobId, onReset }: Props) {
  const [update, setUpdate] = useState<JobUpdate>({ status: 'PENDING', progressPct: 0 });
  const [logs, setLogs] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/v1/imports/${jobId}/stream`);

    es.onmessage = (event) => {
      const data = JSON.parse(event.data as string) as JobUpdate;
      if (data.status) {
        setUpdate(data);
        if (data.logMessage) {
          const timestamp = new Date().toLocaleTimeString();
          setLogs((prev) => {
            const next = [...prev, `[${timestamp}] ${data.logMessage}`];
            return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
          });
        }
      }
    };

    es.onerror = () => {
      es.close();
    };

    return () => {
      es.close();
    };
  }, [jobId]);

  // Auto-scroll to bottom when new log lines arrive
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const isTerminal = ['COMPLETED', 'FAILED', 'FAILED_RATE_LIMIT'].includes(update.status);
  const colorClass = STATUS_COLORS[update.status] ?? 'text-gray-400';

  return (
    <div className="bg-gray-900 rounded-2xl p-8 shadow-xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Import Progress</h2>
        <span className={`text-sm font-medium ${colorClass}`}>{update.status}</span>
      </div>

      <div>
        <div className="flex justify-between text-sm text-gray-400 mb-1">
          <span>Progress</span>
          <span>{update.progressPct}%</span>
        </div>
        <div className="w-full bg-gray-800 rounded-full h-3">
          <div
            className="bg-indigo-500 h-3 rounded-full transition-all duration-500"
            style={{ width: `${update.progressPct}%` }}
          />
        </div>
      </div>

      {logs.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-3 h-48 overflow-y-auto font-mono text-xs text-gray-300 space-y-0.5">
          {logs.map((line, i) => (
            <div key={i} className="leading-relaxed opacity-90">
              {line}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}

      <p className="text-xs text-gray-500 break-all">Job ID: {jobId}</p>

      {isTerminal && (
        <div className="space-y-2">
          {update.status === 'COMPLETED' && (
            <>
              <Link
                href="/creators?userId=demo-user-id"
                className="block w-full text-center bg-indigo-700 hover:bg-indigo-600 rounded-lg py-2 text-sm font-medium transition-colors"
              >
                View Imported Creators
              </Link>
              <Link
                href="/items?userId=demo-user-id"
                className="block w-full text-center bg-gray-700 hover:bg-gray-600 rounded-lg py-2 text-sm font-medium transition-colors"
              >
                View Imported Items
              </Link>
            </>
          )}
          <button
            onClick={onReset}
            className="w-full bg-gray-700 hover:bg-gray-600 rounded-lg py-2 text-sm font-medium transition-colors"
          >
            Start New Import
          </button>
        </div>
      )}
    </div>
  );
}
