/* eslint-disable @typescript-eslint/no-require-imports */
/** @type {import('next').NextConfig} */
const { createSecurityHeaders } = require('./src/config/security-headers');

const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    domains: ['localhost'],
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api',
  },
  outputFileTracingRoot: __dirname,
  async headers() {
    return [{
      source: '/(.*)',
      headers: createSecurityHeaders()
    }];
  },
}

module.exports = nextConfig
