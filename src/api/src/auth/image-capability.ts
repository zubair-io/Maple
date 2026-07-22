import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { getDb } from '../db/client.ts';

type ImageCapabilityDoc = {
  _id: string;
  path: string;
  expires_at: Date;
  created_at: Date;
  purpose: 'image-read';
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const IMAGE_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Validate a short-lived, path-bound image capability from the URL. These are
 * intentionally narrower than access JWTs: GET-only, exact path, and limited
 * to the thumbnail/preview route families.
 */
export async function verifyImageCapability(request: Request, dbOverride?: Db): Promise<boolean> {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/thumb/') && !url.pathname.startsWith('/api/preview/'))
    return false;
  const token = url.searchParams.get('token');
  if (!token || !IMAGE_CAPABILITY_PATTERN.test(token)) return false;
  const row = await (dbOverride ?? (await getDb()))
    .collection<ImageCapabilityDoc>('image_access_tokens')
    .findOne({
      _id: hashToken(token),
      path: url.pathname,
      purpose: 'image-read',
      expires_at: { $gt: new Date() },
    });
  return row !== null;
}
