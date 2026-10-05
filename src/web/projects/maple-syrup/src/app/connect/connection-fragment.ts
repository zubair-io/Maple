// #4230: runs before Angular and any application initialization. Sensitive
// callback material is kept only in this module and removed from history.
export interface ConnectionFragment {
  ticket: string;
  authorizationUrl?: string;
  code?: string;
  error?: string;
}
let captured: ConnectionFragment | null = null;
function decodeConnectionFragment(fragment: string): Record<string, unknown> | null {
  if (!fragment || fragment.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(fragment)) return null;
  const bytes = Uint8Array.from(atob(fragment.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  );
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function fragmentTicket(body: Record<string, unknown>): string | null {
  const ticket = body['ticket'];
  return typeof ticket === 'string' &&
    ticket.length <= 4096 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket)
    ? ticket
    : null;
}
function validReturnCode(code: unknown): code is string {
  return typeof code === 'string' && code.length <= 4096 && !/[\x00-\x20\x7f]/.test(code);
}
function validReturnError(error: unknown): error is string {
  return typeof error === 'string' && /^[a-z_]{1,64}$/.test(error);
}
function returnFragment(body: Record<string, unknown>, ticket: string): ConnectionFragment | null {
  const code = body['code'];
  const error = body['error'];
  if (Boolean(code) === Boolean(error)) return null;
  if (code && !validReturnCode(code)) return null;
  if (error && !validReturnError(error)) return null;
  return { ticket, ...(typeof code === 'string' ? { code } : { error: error as string }) };
}
function authorizationFragment(
  body: Record<string, unknown>,
  ticket: string,
): ConnectionFragment | null {
  const authorizationUrl = body['authorizationUrl'];
  return typeof authorizationUrl === 'string' && authorizationUrl.length <= 8192
    ? { ticket, authorizationUrl }
    : null;
}
function parseConnectionFragment(fragment: string, pathname: string): ConnectionFragment | null {
  try {
    const body = decodeConnectionFragment(fragment);
    if (!body) return null;
    const ticket = fragmentTicket(body);
    if (!ticket) return null;
    return pathname.endsWith('/return')
      ? returnFragment(body, ticket)
      : authorizationFragment(body, ticket);
  } catch {
    // Invalid fragments are discarded, including their history entry.
    return null;
  }
}
export function captureConnectionFragment(
  location: Pick<Location, 'pathname' | 'hash' | 'search'>,
  history: Pick<History, 'replaceState'>,
): void {
  if (!['/connect/google-drive', '/connect/google-drive/return'].includes(location.pathname))
    return;
  const fragment = location.hash.slice(1);
  history.replaceState(null, '', `${location.pathname}?ngsw-bypass=true`);
  captured = null;
  captured = parseConnectionFragment(fragment, location.pathname);
}
export function takeConnectionFragment(): ConnectionFragment | null {
  const fragment = captured;
  captured = null;
  return fragment;
}
if (typeof window !== 'undefined') captureConnectionFragment(window.location, window.history);
