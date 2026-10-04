import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { map, Observable } from 'rxjs';
import { ConnectionFragment } from './connection-fragment';

export interface ConnectionTicket {
  version: 1;
  nonce: string;
  clientId: string;
  challenge: string;
  returnUrl: string;
  redirectUri: string;
  expiresAt: number;
  scope: string;
}
const CALLBACK = 'https://mapleeditor.com/api/connect/google-drive/callback';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export function validateConnectionTicket(value: unknown): ConnectionTicket {
  if (!value || typeof value !== 'object') throw new Error('Invalid connection');
  const ticket = value as Record<string, unknown>;
  if (typeof ticket['returnUrl'] !== 'string' || ticket['returnUrl'].length > 2048)
    throw new Error('Invalid connection');
  const returnUrl = new URL(ticket['returnUrl']);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(returnUrl.hostname);
  if (
    ticket['version'] !== 1 ||
    ticket['scope'] !== SCOPE ||
    ticket['redirectUri'] !== CALLBACK ||
    typeof ticket['nonce'] !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(ticket['nonce']) ||
    typeof ticket['challenge'] !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(ticket['challenge']) ||
    typeof ticket['clientId'] !== 'string' ||
    !/^[A-Za-z0-9_-]{8,200}\.apps\.googleusercontent\.com$/.test(ticket['clientId']) ||
    typeof ticket['expiresAt'] !== 'number' ||
    !Number.isSafeInteger(ticket['expiresAt']) ||
    ticket['expiresAt'] <= Date.now() ||
    ticket['expiresAt'] > Date.now() + 600000 ||
    (returnUrl.protocol !== 'https:' && !(loopback && returnUrl.protocol === 'http:')) ||
    returnUrl.username ||
    returnUrl.password ||
    returnUrl.search ||
    returnUrl.hash ||
    returnUrl.pathname !== '/api/cloud-backup/google/callback'
  )
    throw new Error('Invalid connection');
  return value as ConnectionTicket;
}
export function validatedAuthorizationUrl(
  fragment: ConnectionFragment,
  ticket: ConnectionTicket,
): string {
  const url = new URL(fragment.authorizationUrl ?? '');
  const expected: Record<string, string> = {
    client_id: ticket.clientId,
    redirect_uri: ticket.redirectUri,
    response_type: 'code',
    scope: ticket.scope,
    code_challenge: ticket.challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    state: fragment.ticket,
  };
  if (
    url.origin !== 'https://accounts.google.com' ||
    url.pathname !== '/o/oauth2/v2/auth' ||
    url.hash ||
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((key) => !Object.hasOwn(expected, key)) ||
    Object.entries(expected).some(
      ([key, value]) =>
        url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value,
    )
  )
    throw new Error('Invalid authorization request');
  return url.href;
}
export function callbackDestination(
  fragment: ConnectionFragment,
  ticket: ConnectionTicket,
): string {
  const url = new URL(ticket.returnUrl);
  url.searchParams.set('state', fragment.ticket);
  if (fragment.code) url.searchParams.set('code', fragment.code);
  else if (fragment.error) url.searchParams.set('error', fragment.error);
  else throw new Error('Missing callback');
  return url.href;
}
@Injectable({ providedIn: 'root' })
export class ConnectionService {
  private readonly http = inject(HttpClient);
  validate(ticket: string): Observable<ConnectionTicket> {
    return this.http
      .post<unknown>(
        '/api/connect/google-drive/validate',
        { ticket },
        { headers: new HttpHeaders({ 'ngsw-bypass': 'true' }) },
      )
      .pipe(map(validateConnectionTicket));
  }
}
