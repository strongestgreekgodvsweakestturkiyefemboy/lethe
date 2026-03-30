import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // Server-side proxy: forward /api/* and /healthz to the backend via the
    // load-balancer VIP.  BACKEND_URL is a server-only env var (no NEXT_PUBLIC_
    // prefix) so it is never shipped to the browser — clients never learn the
    // backend address.  All traffic flows through HAProxy → Nginx → backend;
    // port 3001 is never directly reachable from the outside.
    const backendBase = process.env.BACKEND_URL ?? 'http://localhost:3001';
    return [
      {
        source: '/api/:path*',
        destination: `${backendBase}/api/:path*`,
      },
      {
        source: '/healthz',
        destination: `${backendBase}/healthz`,
      },
    ];
  },
};

export default nextConfig;
