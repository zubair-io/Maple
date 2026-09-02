/**
 * Maple Hosted's production security policy, applied to every response this
 * Worker returns.
 *
 * This is an independent re-implementation of
 * `src/web/scripts/hosted-security-header-contract.ts` — this Worker is a
 * standalone deploy unit with no shared imports into `src/web` (same
 * convention as the thumbnail-cache Worker's `src/r2.ts` / `src/auth.ts`).
 * Keep the two in sync by hand if either changes.
 *
 * Cloudflare Pages / Netlify deployments of this same app pick these values
 * up automatically from `projects/maple-syrup/public/_headers`, which is
 * inert on Azure Blob Storage. This Worker fronts the Azure origin for the
 * production `mapleaperture.com` domain and is what actually applies them.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	'Cross-Origin-Embedder-Policy': 'require-corp',
	'Cross-Origin-Opener-Policy': 'same-origin',
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
};

/** Azure Blob Storage response headers that leak storage-account
 * implementation detail and serve no purpose for a browser client — strip
 * them rather than let them pass through to the public response. */
const STRIPPED_HEADER_PREFIXES = ['x-ms-'];
const STRIPPED_HEADER_NAMES = new Set(['server']);

/**
 * Builds the outgoing response headers for a proxied origin response:
 * starts from the origin's own headers (so a real `Content-Type`,
 * `Content-Length`, `ETag`, and whatever `Cache-Control` the origin actually
 * set survive untouched — see the module doc on why this Worker never
 * invents its own cache policy), strips Azure implementation-detail
 * headers, then layers the security contract on top.
 */
export function buildResponseHeaders(originHeaders: Headers): Headers {
	const headers = new Headers();
	for (const [name, value] of originHeaders) {
		const lower = name.toLowerCase();
		if (STRIPPED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
		if (STRIPPED_HEADER_NAMES.has(lower)) continue;
		headers.set(name, value);
	}
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
	return headers;
}
