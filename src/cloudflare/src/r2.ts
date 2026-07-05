/**
 * R2 object key derivation + binding helpers.
 *
 * Mirrors `src/api/src/cloudflare/thumb-key.ts` byte-for-byte. The Worker
 * has no database access, so it derives the key straight from the request
 * URL (`/api/thumb/<slug>/<relDir…>/<filename>`) rather than looking up
 * `maple_id` — see that file's header comment for the full rationale. Keep
 * the two derivations in sync by hand; there is no shared import between
 * the two deploy units.
 */

export interface ThumbAddress {
	slug: string;
	relDir: string;
	filename: string;
}

/** Parse `/api/thumb/<slug>/<...>` into its address components, matching
 * `routes/library/thumb.ts` + `parseWildcardSegments` on the API side:
 * the last segment is the filename, everything between the slug and the
 * filename is the relative directory. Returns `null` for any path that
 * isn't a `/api/thumb/*` request with a non-empty slug and filename. */
export function parseThumbPath(pathname: string): ThumbAddress | null {
	const prefix = '/api/thumb/';
	if (!pathname.startsWith(prefix)) return null;
	const rest = pathname.slice(prefix.length);
	if (!rest) return null;

	const rawSegments = rest.split('/').filter((s) => s.length > 0);
	if (rawSegments.length < 2) return null; // need at least slug + filename

	const segments = rawSegments.map((seg) => {
		try {
			return decodeURIComponent(seg);
		} catch {
			return seg;
		}
	});

	const slug = segments[0];
	const filename = segments[segments.length - 1];
	const relDir = segments.slice(1, -1).join('/');
	if (!slug || !filename) return null;
	return { slug, relDir, filename };
}

/** Produce the R2 object key for a thumbnail address — identical
 * construction to `thumbR2Key` in `src/api/src/cloudflare/thumb-key.ts`. */
export function thumbR2Key({ slug, relDir, filename }: ThumbAddress): string {
	const segments = [slug, ...relDir.split('/').filter(Boolean), filename];
	return `thumbs/${segments.map(encodeURIComponent).join('/')}`;
}
