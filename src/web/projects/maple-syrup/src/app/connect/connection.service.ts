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
function matchesTicketField(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}
function validTicketExpiry(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > Date.now() &&
    value <= Date.now() + 600000
  );
}
function validateTicketBindings(ticket: Record<string, unknown>): void {
  const randomField = /^[A-Za-z0-9_-]{43}$/;
  if (
    ticket['version'] !== 1 ||
    ticket['scope'] !== SCOPE ||
    ticket['redirectUri'] !== CALLBACK ||
    !matchesTicketField(ticket['nonce'], randomField) ||
    !matchesTicketField(ticket['challenge'], randomField) ||
    !matchesTicketField(
      ticket['clientId'],
      /^[A-Za-z0-9_-]{8,200}\.apps\.googleusercontent\.com$/,
    ) ||
    !validTicketExpiry(ticket['expiresAt'])
  )
    throw new Error('Invalid connection');
}
function validCallbackProtocol(url: URL): boolean {
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return url.protocol === 'https:' || (loopback && url.protocol === 'http:');
}
function validateCallbackUrl(value: unknown): void {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid connection');
  const url = new URL(value);
  if (
    !validCallbackProtocol(url) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/api/cloud-backup/google/callback'
  )
    throw new Error('Invalid connection');
}
export function validateConnectionTicket(value: unknown): ConnectionTicket {
  if (!value || typeof value !== 'object') throw new Error('Invalid connection');
  const ticket = value as Record<string, unknown>;
  validateCallbackUrl(ticket['returnUrl']);
  validateTicketBindings(ticket);
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
