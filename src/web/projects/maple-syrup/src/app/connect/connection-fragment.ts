// #4230: runs before Angular and any application initialization. Sensitive
// callback material is kept only in this module and removed from history.
export interface ConnectionFragment {
  ticket: string;
  authorizationUrl?: string;
  code?: string;
  error?: string;
}
let captured: ConnectionFragment | null = null;
export function captureConnectionFragment(
  location: Pick<Location, 'pathname' | 'hash' | 'search'>,
  history: Pick<History, 'replaceState'>,
): void {
  if (!['/connect/google-drive', '/connect/google-drive/return'].includes(location.pathname))
    return;
  const fragment = location.hash.slice(1);
  history.replaceState(null, '', `${location.pathname}?ngsw-bypass=true`);
  captured = null;
  try {
    if (!fragment || fragment.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(fragment)) return;
    const bytes = Uint8Array.from(atob(fragment.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    );
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const body = value as Record<string, unknown>;
    if (
      typeof body['ticket'] !== 'string' ||
      body['ticket'].length > 4096 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body['ticket'])
    )
      return;
    if (location.pathname.endsWith('/return')) {
      const code = body['code'];
      const error = body['error'];
      if (
        Boolean(code) === Boolean(error) ||
        (code &&
          (typeof code !== 'string' || code.length > 4096 || /[\x00-\x20\x7f]/.test(code))) ||
        (error && (typeof error !== 'string' || !/^[a-z_]{1,64}$/.test(error)))
      )
        return;
      captured = {
        ticket: body['ticket'],
        ...(typeof code === 'string' ? { code } : { error: error as string }),
      };
    } else if (
      typeof body['authorizationUrl'] === 'string' &&
      body['authorizationUrl'].length <= 8192
    ) {
      captured = { ticket: body['ticket'], authorizationUrl: body['authorizationUrl'] };
    }
  } catch {
    /* Invalid fragments are discarded, including their history entry. */
  }
}
export function takeConnectionFragment(): ConnectionFragment | null {
  const fragment = captured;
  captured = null;
  return fragment;
}
if (typeof window !== 'undefined') captureConnectionFragment(window.location, window.history);
