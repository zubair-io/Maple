// Tiny static server for qualifying the production Angular artifact under the
// same security policy its static-host `_headers` file declares.
//
// Usage: DIST=<abs path to dist/.../browser> PORT=4300 bun scripts/serve-dist-coep.mjs
import { file } from 'bun';
import { join, extname, normalize, resolve, sep } from 'node:path';
import {
  CROSS_ORIGIN_ISOLATION_HEADERS,
  HOSTED_SECURITY_HEADERS,
} from './hosted-security-header-contract.ts';
import { HOSTED_UPDATE_CONTROL_PATH } from '../e2e/support/production-update-contract.ts';
import {
  SELF_HOSTED_THUMBNAIL_CACHE_PROBE,
  SELF_HOSTED_UNCACHED_API_PROBES,
} from '../e2e/support/production-cache-contract.ts';

if (!process.env.DIST) {
  console.error('Set DIST to the browser dist dir');
  process.exit(1);
}
// Resolve to an absolute, separator-normalized root so the traversal guard's
// `DIST + sep` boundary check is exact (no trailing-slash surprises).
const DIST = resolve(process.env.DIST);
const UPDATE_DIST = process.env.MAPLE_E2E_UPDATE_DIST
  ? resolve(process.env.MAPLE_E2E_UPDATE_DIST)
  : undefined;
const UPDATE_VERSION_ROOTS = new Map([
  ['v1', DIST],
  ['v2', UPDATE_DIST],
]);
let activeDist = DIST;
const PORT = Number(process.env.PORT ?? 4300);
const API_UNAVAILABLE_STATUS = Number(process.env.API_UNAVAILABLE_STATUS ?? 0);
const SELF_HOSTED_CACHE_FIXTURES = process.env.MAPLE_E2E_SELF_HOSTED_CACHE_FIXTURES === '1';
const SELF_HOSTED_CACHE_FIXTURE_PATHS = new Set([
  SELF_HOSTED_THUMBNAIL_CACHE_PROBE,
  ...SELF_HOSTED_UNCACHED_API_PROBES,
]);
const SECURITY_HEADERS =
  process.env.MAPLE_HOSTED_SECURITY_POLICY === '0'
    ? CROSS_ORIGIN_ISOLATION_HEADERS
    : HOSTED_SECURITY_HEADERS;
const SECURITY_POLICY_NAME =
  process.env.MAPLE_HOSTED_SECURITY_POLICY === '0' ? 'cross-origin isolation' : 'Hosted production';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.dng': 'image/x-adobe-dng',
};

/** Default `/` (and empty) to index.html; leave everything else untouched. */
function resolvePathname(rawPathname) {
  const p = decodeURIComponent(rawPathname);
  return p === '/' || p === '' ? '/index.html' : p;
}

/**
 * Directory-traversal guard: an exact match or a real separator boundary, so a
 * sibling like `${DIST}_secrets/…` can't pass a bare prefix check. Mirrors
 * src/api's static_ui.ts.
 */
function isWithinRoot(root, abs) {
  return abs === root || abs.startsWith(root + sep);
}

function contentTypeFor(abs) {
  return MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
}

function productionResponse(body, contentType, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
    },
  });
}

function unavailableApiResponse(pathname) {
  if (!API_UNAVAILABLE_STATUS) return null;
  if (pathname === '/api/auth/bootstrap') {
    return productionResponse(
      JSON.stringify({ claimed: true, dev_login_enabled: false }),
      'application/json',
    );
  }
  if (pathname.startsWith('/api/')) {
    return productionResponse('Unauthorized', 'text/plain; charset=utf-8', API_UNAVAILABLE_STATUS);
  }
  return null;
}

function selfHostedCacheFixtureResponse(pathname) {
  if (!SELF_HOSTED_CACHE_FIXTURES || !SELF_HOSTED_CACHE_FIXTURE_PATHS.has(pathname)) return null;
  return productionResponse(JSON.stringify({ pathname }), 'application/json');
}

async function hostedUpdateControlResponse(req, pathname) {
  if (UPDATE_DIST === undefined) return undefined;
  if (`${req.method} ${pathname}` !== `POST ${HOSTED_UPDATE_CONTROL_PATH}`) return undefined;
  const requested = await requestedHostedVersion(req);
  const requestedRoot = UPDATE_VERSION_ROOTS.get(requested);
  if (requestedRoot === undefined) {
    return productionResponse('Invalid version', 'text/plain; charset=utf-8', 400);
  }
  activeDist = requestedRoot;
  return productionResponse(JSON.stringify({ version: requested }), 'application/json');
}

async function requestedHostedVersion(req) {
  try {
    return /** @type {{ version?: unknown }} */ (await req.json()).version;
  } catch {
    return undefined;
  }
}

async function handle(req) {
  const pathname = new URL(req.url).pathname;
  const apiResponse = unavailableApiResponse(pathname);
  if (apiResponse) return apiResponse;
  const root = activeDist;
  const abs = normalize(join(root, resolvePathname(pathname)));
  if (!isWithinRoot(root, abs)) {
    return productionResponse('Forbidden', 'text/plain; charset=utf-8', 403);
  }
  const f = file(abs);
  if (await f.exists()) return productionResponse(f, contentTypeFor(abs));
  // SPA fallback.
  return productionResponse(file(join(root, 'index.html')), 'text/html; charset=utf-8');
}

async function route(req) {
  const pathname = new URL(req.url).pathname;
  return (
    (await hostedUpdateControlResponse(req, pathname)) ??
    selfHostedCacheFixtureResponse(pathname) ??
    handle(req)
  );
}

Bun.serve({ port: PORT, fetch: route });
console.log(
  `serving ${DIST} on http://localhost:${PORT} with ${SECURITY_POLICY_NAME} headers` +
    (UPDATE_DIST ? ` (update fixture: ${UPDATE_DIST})` : ''),
);
