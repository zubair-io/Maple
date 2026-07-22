/**
 * Thin wrapper around a single PUT to a Cloudflare R2 bucket via its
 * S3-compatible API, signed with `aws4fetch` (pure `fetch`, no Node-stream
 * dependency — thumbnails are single AVIFs well under any multipart
 * threshold, so the full AWS SDK's surface area buys nothing here).
 *
 * No retry logic lives in this module — retries are a caller policy:
 * best-effort with a short timeout from the indexer's live-upload hook,
 * real retry/backoff from the backfill job (`cloudflare/backfill-job.ts`,
 * sub-issue 4).
 */

import { AwsClient } from 'aws4fetch';

export interface ResolvedCloudflareConfig {
  account_id: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
}

function r2Endpoint(config: ResolvedCloudflareConfig, key: string): string {
  return `https://${config.account_id}.r2.cloudflarestorage.com/${config.bucket}/${key}`;
}

function r2Client(config: ResolvedCloudflareConfig): AwsClient {
  return new AwsClient({
    accessKeyId: config.access_key_id,
    secretAccessKey: config.secret_access_key,
    // aws4fetch retries 5xx/429 internally by default (10 attempts,
    // exponential backoff up to ~1 minute) — that policy belongs to the
    // CALLER per this module's own contract (see file header), not baked
    // in here where a caller's own bounded-timeout wrapper (e.g. the
    // indexer's 5s hook) would otherwise race against it and always lose.
    retries: 0,
    // R2's S3-compatible endpoint ignores region, but SigV4 requires a
    // value — "auto" is Cloudflare's documented convention.
    region: 'auto',
    service: 's3',
  });
}

/** Upload thumbnail bytes to R2 under `key`, tagged with `contentType`
 * (the Cloudflare Worker forwards this back to clients on a cache hit — see
 * `src/cloudflare/src/index.ts`). Throws on any non-2xx response or network
 * failure — callers decide whether that's fatal. `signal`, when supplied,
 * aborts the underlying fetch (not just the caller's wait) — see the
 * indexer hook's use of `AbortSignal.timeout()`. */
export async function uploadThumbToR2(
  config: ResolvedCloudflareConfig,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  signal?: AbortSignal,
): Promise<void> {
  const client = r2Client(config);
  const res = await client.fetch(r2Endpoint(config, key), {
    method: 'PUT',
    body: bytes as BodyInit,
    headers: { 'Content-Type': contentType },
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`R2 upload failed (${res.status}): ${body.slice(0, 500)}`);
  }
}

/** Delete a thumbnail from R2 — used when an asset transitions to hidden
 * (see `cloudflare/hidden-cleanup.ts`) so it stops being fetchable from the
 * edge cache. A 404 (already absent) is not an error: the caller doesn't
 * know or care whether the object ever made it to R2 in the first place.
 * `signal`, when supplied, aborts the underlying fetch — same contract as
 * `uploadThumbToR2`'s, since this is awaited from worker-stage handlers
 * where an unbounded network call would stall the stage's concurrency slot
 * indefinitely on an R2-side hang. */
export async function deleteThumbFromR2(
  config: ResolvedCloudflareConfig,
  key: string,
  signal?: AbortSignal,
): Promise<void> {
  const client = r2Client(config);
  const res = await client.fetch(r2Endpoint(config, key), { method: 'DELETE', signal });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`R2 delete failed (${res.status}): ${body.slice(0, 500)}`);
  }
}

/** HEAD a thumbnail object to check whether it currently exists in R2.
 * `true` on 2xx, `false` on 404 (the object is genuinely absent). Any other
 * non-2xx or a network failure throws — an ambiguous response must not be
 * read as "absent" (which would wrongly re-arm cf-thumb-sync). `signal`
 * bounds the request the same way the upload/delete paths do, since the
 * derivative-audit worker HEADs many objects per pass. */
export async function thumbExistsInR2(
  config: ResolvedCloudflareConfig,
  key: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const client = r2Client(config);
  const res = await client.fetch(r2Endpoint(config, key), { method: 'HEAD', signal });
  if (res.ok) return true;
  if (res.status === 404) return false;
  const body = await res.text().catch(() => '');
  throw new Error(`R2 head failed (${res.status}): ${body.slice(0, 500)}`);
}

/** Round-trip a small object (PUT then DELETE) to validate a set of R2
 * credentials without leaving anything behind. Used by
 * `POST /api/cloudflare/test`. */
export async function testR2Credentials(config: ResolvedCloudflareConfig): Promise<void> {
  const client = r2Client(config);
  const probeKey = `_maple_credential_probe/${crypto.randomUUID()}`;
  const putRes = await client.fetch(r2Endpoint(config, probeKey), {
    method: 'PUT',
    body: new Uint8Array(0),
  });
  if (!putRes.ok) {
    const body = await putRes.text().catch(() => '');
    throw new Error(`R2 credential probe PUT failed (${putRes.status}): ${body.slice(0, 500)}`);
  }
  // Best-effort cleanup — a failed DELETE doesn't invalidate the probe
  // (the credentials clearly worked if the PUT above succeeded).
  await client.fetch(r2Endpoint(config, probeKey), { method: 'DELETE' }).catch(() => undefined);
}
