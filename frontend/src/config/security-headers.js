const GOOGLE_MAPS_SCRIPT_ORIGINS = [
  'https://maps.googleapis.com',
  'https://maps.gstatic.com'
];

const GOOGLE_MAPS_CONNECT_ORIGINS = [
  ...GOOGLE_MAPS_SCRIPT_ORIGINS,
  'https://places.googleapis.com'
];

const GOOGLE_MAPS_IMAGE_ORIGINS = [
  ...GOOGLE_MAPS_SCRIPT_ORIGINS,
  'https://streetviewpixels-pa.googleapis.com',
  'https://lh3.ggpht.com'
];

const GOOGLE_MAPS_STYLE_ORIGIN = 'https://fonts.googleapis.com';
const GOOGLE_MAPS_FONT_ORIGIN = 'https://fonts.gstatic.com';

const getHttpOrigin = (value) => {
  if (!value || value.startsWith('/')) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
};

const createContentSecurityPolicy = ({ nodeEnvironment, apiUrl }) => {
  const development = nodeEnvironment === 'development';
  const apiOrigin = getHttpOrigin(apiUrl);
  const scriptSources = [
    "'self'",
    // Next.js emits inline bootstrap scripts. Nonces require dynamic rendering,
    // which is intentionally deferred from this first CSP iteration.
    "'unsafe-inline'",
    ...(development ? ["'unsafe-eval'"] : []),
    ...GOOGLE_MAPS_SCRIPT_ORIGINS
  ];
  const connectSources = [
    "'self'",
    ...(apiOrigin ? [apiOrigin] : []),
    ...GOOGLE_MAPS_CONNECT_ORIGINS,
    'https://nominatim.openstreetmap.org',
    ...(development ? ['ws://localhost:*', 'ws://127.0.0.1:*'] : [])
  ];

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    `style-src 'self' 'unsafe-inline' ${GOOGLE_MAPS_STYLE_ORIGIN}`,
    `img-src 'self' data: blob: ${GOOGLE_MAPS_IMAGE_ORIGINS.join(' ')}`,
    `font-src 'self' ${GOOGLE_MAPS_FONT_ORIGIN}`,
    `connect-src ${connectSources.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "manifest-src 'self'",
    "media-src 'none'"
  ].join('; ');
};

const createSecurityHeaders = (environment = process.env) => [{
  key: 'Content-Security-Policy',
  value: createContentSecurityPolicy({
    nodeEnvironment: environment.NODE_ENV,
    apiUrl: environment.NEXT_PUBLIC_API_URL
  })
}, {
  key: 'X-Content-Type-Options',
  value: 'nosniff'
}, {
  key: 'Referrer-Policy',
  value: 'strict-origin-when-cross-origin'
}, {
  key: 'Permissions-Policy',
  value: 'camera=(), microphone=(), geolocation=(self)'
}, {
  key: 'X-Frame-Options',
  value: 'DENY'
}, {
  // Printing uses an about:blank popup; allow it without exposing window.opener.
  key: 'Cross-Origin-Opener-Policy',
  value: 'same-origin-allow-popups'
}];

module.exports = {
  GOOGLE_MAPS_CONNECT_ORIGINS,
  GOOGLE_MAPS_FONT_ORIGIN,
  GOOGLE_MAPS_IMAGE_ORIGINS,
  GOOGLE_MAPS_SCRIPT_ORIGINS,
  GOOGLE_MAPS_STYLE_ORIGIN,
  createContentSecurityPolicy,
  createSecurityHeaders
};
