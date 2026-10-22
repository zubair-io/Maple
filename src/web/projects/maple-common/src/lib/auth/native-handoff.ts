/**
 * Native sign-in handoff request parsed from the initial browser URL (#856, #4673).
 *
 * Custom URL schemes we will hand a one-time auth code to. The native shells
 * register `maple-app://`; we honor ONLY known schemes, so a page loaded with
 * an attacker-supplied `?native_callback=…` is ignored (#856).
 */
const NATIVE_SCHEME_ALLOWLIST = new Set(['maple-app']);

export interface NativeHandoffRequest {
  readonly scheme: string;
  readonly codeChallenge: string;
  readonly state: string;
  /** Display platform for the consent interstitial (e.g. 'macOS', 'Windows', 'Android', 'Linux'). */
  readonly platform: string;
  /** Display device label for the consent interstitial. */
  readonly device: string;
  /** Explicit `device_label` query param if the native shell passed one, forwarded to `/api/auth/native-code`. */
  readonly explicitDeviceLabel: string | null;
}

function sanitizeLabel(raw: string | null, maxLen = 64): string | null {
  if (!raw) return null;
  const trimmed = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLen);
  return trimmed.length > 0 ? trimmed : null;
}

function browserPlatformHint(): string {
  try {
    const nav = globalThis.navigator as
      | (Navigator & { userAgentData?: { platform?: string } })
      | undefined;
    const raw = nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '';
    return raw;
  } catch {
    return '';
  }
}

function detectBrowserPlatform(): string {
  const raw = browserPlatformHint();
  const platforms: readonly (readonly [RegExp, string])[] = [
    [/android/i, 'Android'],
    [/iphone|ipad|ipod|ios/i, 'iOS'],
    [/mac/i, 'macOS'],
    [/win/i, 'Windows'],
    [/linux/i, 'Linux'],
  ];
  return platforms.find(([pattern]) => pattern.test(raw))?.[1] ?? 'Native app';
}

export function parseNativeHandoffSearch(search: string): {
  scheme: string | null;
  request: NativeHandoffRequest | null;
} {
  try {
    const p = new URLSearchParams(search);
    const cb = p.get('native_callback')?.toLowerCase() ?? null;
    const scheme = cb && NATIVE_SCHEME_ALLOWLIST.has(cb) ? cb : null;
    if (!scheme) return { scheme: null, request: null };

    const codeChallenge = p.get('code_challenge') ?? '';
    const state = p.get('state') ?? '';
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge) || !/^[A-Za-z0-9_-]{8,256}$/.test(state)) {
      return { scheme, request: null };
    }
    const platform = sanitizeLabel(p.get('platform'), 32) ?? detectBrowserPlatform();
    const explicitDeviceLabel = sanitizeLabel(p.get('device_label') ?? p.get('device'), 64);
    const device = explicitDeviceLabel ?? `Maple on ${platform}`;
    return {
      scheme,
      request: {
        scheme,
        codeChallenge,
        state,
        platform,
        device,
        explicitDeviceLabel,
      },
    };
  } catch {
    return { scheme: null, request: null };
  }
}

export function scrubNativeHandoffUrl(): void {
  try {
    const url = new URL(window.location.href);
    for (const key of [
      'native_callback',
      'code_challenge',
      'state',
      'platform',
      'device_label',
      'device',
    ]) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(null, '', url.toString());
  } catch {
    /* SSR / non-browser */
  }
}
