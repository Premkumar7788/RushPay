import type { NextConfig } from 'next';

// Static export: the demo is served from ./out with no server, so it runs fully offline.
const nextConfig: NextConfig = { output: 'export' };

export default nextConfig;
