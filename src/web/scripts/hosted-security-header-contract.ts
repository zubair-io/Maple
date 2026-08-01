/**
 * Production security policy for Maple Hosted.
 *
 * Keep this as the single executable source of truth. The local artifact
 * server consumes it directly, while the artifact checker proves the static
 * host's `_headers` file expresses the same values.
 */
export const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
} as const satisfies Readonly<Record<string, string>>;

export const HOSTED_SECURITY_HEADERS = {
  ...CROSS_ORIGIN_ISOLATION_HEADERS,
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "img-src 'self' blob: data:",
    "manifest-src 'self'",
    "object-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join('; '),
  'Permissions-Policy': [
    'accelerometer=()',
    'camera=()',
    'geolocation=()',
    'gyroscope=()',
    'magnetometer=()',
    'microphone=()',
    'payment=()',
    'usb=()',
  ].join(', '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const satisfies Readonly<Record<string, string>>;
