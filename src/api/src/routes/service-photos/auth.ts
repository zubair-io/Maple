/**
 * Service-key authentication for `/api/service/*`, answering in the `{ error, message }` shape.
 */

import type { Context } from 'elysia';
import {
  authenticateServiceApiKey,
  type ServiceApiAuthResult,
  type ServiceApiIdentity,
} from '../../auth/service-api-keys.ts';
import type { ServiceApiScope } from '../../db/schema.ts';

export interface ServiceError {
  error: string;
  message: string;
}

type AuthFailure = Extract<ServiceApiAuthResult, { ok: false }>['reason'];

const AUTH_MESSAGES: Record<AuthFailure, string> = {
  missing_bearer: 'Send the service key as "Authorization: Bearer maple_sk_…".',
  invalid_key: 'The service key is not recognised.',
  expired_key: 'The service key has expired.',
  revoked_key: 'The service key has been revoked.',
  insufficient_scope: 'The service key does not have the scope this endpoint needs.',
};

export function serviceError(
  set: Context['set'],
  status: number,
  error: string,
  message: string,
): ServiceError {
  set.status = status;
  return { error, message };
}

export function notFound(set: Context['set']): ServiceError {
  return serviceError(set, 404, 'not_found', 'No such photo.');
}

/** The key's identity, or the 401/403 body the request should answer with. */
export async function authorize(
  request: Request,
  scope: ServiceApiScope,
  set: Context['set'],
): Promise<ServiceApiIdentity | ServiceError> {
  const auth = await authenticateServiceApiKey(request.headers.get('authorization'), scope);
  if (auth.ok) return auth.identity;
  const message =
    auth.reason === 'insufficient_scope'
      ? `${AUTH_MESSAGES.insufficient_scope} Required: ${scope}.`
      : AUTH_MESSAGES[auth.reason];
  return serviceError(set, auth.status, auth.reason, message);
}

export function isServiceError(value: unknown): value is ServiceError {
  return value !== null && typeof value === 'object' && 'error' in value && 'message' in value;
}
