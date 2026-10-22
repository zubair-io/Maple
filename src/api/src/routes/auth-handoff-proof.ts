/** Shared proof gate for native and LAN handoff issue routes. */
import { ObjectId } from '../db/object-id.ts';
import { hasHandoffProof } from '../auth/refresh_store.ts';

export async function handoffUserWithProof(
  context: {
    auth: { user: { sub: string } };
    cookie: { maple_refresh?: { value: unknown } };
    body: { refresh_token?: string } | null;
    headers: Record<string, string | undefined>;
    set: { status?: number | string };
  },
  secret: string,
): Promise<ObjectId | null> {
  const userId = new ObjectId(context.auth.user.sub);
  if (await hasHandoffProof(userId, secret, context)) return userId;
  context.set.status = 403;
  return null;
}
