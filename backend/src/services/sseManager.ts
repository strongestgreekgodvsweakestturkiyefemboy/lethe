import { Response } from 'express';
import logger from '../utils/logger';

interface SseClient {
  jobId: string;
  res: Response;
}

const clients: Map<string, SseClient[]> = new Map();

export function addSseClient(jobId: string, res: Response): void {
  const existing = clients.get(jobId) ?? [];
  existing.push({ jobId, res });
  clients.set(jobId, existing);
  logger.debug('SSE client added', { jobId, totalClients: existing.length });
}

export function removeSseClient(jobId: string, res: Response): void {
  const existing = clients.get(jobId) ?? [];
  const filtered = existing.filter((c) => c.res !== res);
  if (filtered.length === 0) {
    clients.delete(jobId);
  } else {
    clients.set(jobId, filtered);
  }
  logger.debug('SSE client removed', { jobId, remainingClients: filtered.length });
}

export function broadcastJobUpdate(
  jobId: string,
  payload: { status: string; progressPct: number; logMessage?: string }
): void {
  const jobClients = clients.get(jobId) ?? [];
  logger.debug('Broadcasting job update to SSE clients', {
    jobId,
    status: payload.status,
    progressPct: payload.progressPct,
    clientCount: jobClients.length,
  });
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of jobClients) {
    client.res.write(data);
  }
}
