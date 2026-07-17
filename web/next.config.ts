import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  turbopack: { root: process.cwd() },
  experimental: { serverActions: { bodySizeLimit: '16mb' } },
}

export default nextConfig
