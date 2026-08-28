// src/api/src/routes/auth-native-code.ts
//
// Native one-time PKCE code exchange (#856). Extracted from auth.ts to keep
// that file under the line budget. Two endpoints, mounted separately in
// index.ts so their auth scopes don't entangle:
//   POST /api/auth/native-code         (authed) — the web app issues a code
//   POST /api/auth/native-code/redeem  (public) — the native app redeems it
import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { usersCollection } from '../db/client.ts';
import { signAccessToken } from '../auth/tokens.ts';
import { toPublicAuthUser, userFileAccess } from '../auth/permissions.ts';
import { issueRefreshToken } from '../auth/refresh_store.ts';
import {
  issueNativeCode,
  redeemNativeCode,
  claimNativeCode,
  type RedeemedNativeCode,
} from '../auth/native_code_store.ts';
import { requireAuth } from '../auth/middleware.ts';
import { rateLimit, clientIp } from '../auth/rate_limit.ts';

function jwtSecret(): string {
  const s = process.env.MAPLE_JWT_SECRET;
  if (!s || s.length < 16) throw new Error('MAPLE_JWT_SECRET unset or too short');
  return s;
}

/** Shared tail of /redeem and /claim: turn a consumed code row into the
 * device-scoped token payload the native app signs in with. */
async function tokensForRedeemed(redeemed: RedeemedNativeCode) {
  const user = await (await usersCollection()).findOne({ _id: redeemed.userId });
  if (!user) return null;
  const access_token = await signAccessToken(
    {
      sub: user._id.toHexString(),
      email: user.email,
      role: user.role,
      file_access: userFileAccess(user),
    },
    jwtSecret(),
  );
  // Mint a fresh, device-scoped refresh token (its own family) rather than
  // handing back the discarded webview session's cookie token.
  const refresh = await issueRefreshToken(user._id, redeemed.deviceLabel);
  return {
    access_token,
    refresh_token: refresh.raw,
    user: toPublicAuthUser(user),
    state: redeemed.state,
  };
}

/**
 * Public redeem. The Apple shell, after the web passkey ceremony, holds a
 * one-time `code` (delivered privately by ASWebAuthenticationSession). It
 * redeems the code + its PKCE verifier here for freshly-minted, device-scoped
 * tokens. No bearer — this is how the native app FIRST obtains tokens. The raw
 * refresh token is returned ONLY here, and never rides in a redirect URL.
 */
export const nativeCodeRedeemRoutes = new Elysia().post(
  '/api/auth/native-code/redeem',
  async ({ body, set, request }) => {
    const ip = clientIp(request);
    if (!rateLimit(`auth:${ip}`, 10, 60_000)) {
      set.status = 429;
      return { error: 'rate limited' };
    }
    const redeemed = await redeemNativeCode(body.code, body.code_verifier);
    if (!redeemed) {
      set.status = 400;
      return { error: 'invalid or expired code' };
    }
    const tokens = await tokensForRedeemed(redeemed);
    if (!tokens) {
      set.status = 401;
      return { error: 'user gone' };
    }
    return tokens;
  },
  { body: t.Object({ code: t.String(), code_verifier: t.String() }) },
);

/**
 * Public polling claim (#3063). Chromium blocks the web app's script-initiated
 * `maple-app://` redirect when the tab has no user gesture — exactly the
 * already-signed-in browser case (#2963/#2964) — so the code the web app mints
 * can be stranded server-side. The native app polls here with the ceremony's
 * `state` and its private PKCE verifier; possession of the verifier proves the
 * same principal `/redeem` would, without the redirect-bound raw code. 404
 * while nothing matching is pending (keep polling); single-use thereafter.
 *
 * Rate limit: its own per-IP bucket, sized for a 2s poll cadence (60/min) so
 * polling never starves the shared `auth:` budget the other flows use.
 */
export const nativeCodeClaimRoutes = new Elysia().post(
  '/api/auth/native-code/claim',
  async ({ body, set, request }) => {
    const ip = clientIp(request);
    if (!rateLimit(`native-claim:${ip}`, 60, 60_000)) {
      set.status = 429;
      return { error: 'rate limited' };
    }
    const redeemed = await claimNativeCode(body.state, body.code_verifier);
    if (!redeemed) {
      set.status = 404;
      return { error: 'no pending code' };
    }
    const tokens = await tokensForRedeemed(redeemed);
    if (!tokens) {
      set.status = 401;
      return { error: 'user gone' };
    }
    return tokens;
  },
  { body: t.Object({ state: t.String(), code_verifier: t.String() }) },
);

/**
 * Authed issue. The web app calls this once a passkey ceremony has established
 * the session, passing the PKCE challenge + opaque state the Apple shell handed
 * it. Returns a short-lived single-use `code` the web app redirects to the
 * app's allowed scheme — tokens never ride in the redirect.
 *
 * Self-gating: `requireAuth` is `.use`d on this instance's own chain (the same
 * pattern as `/me`), so its scoped derive stays contained when mounted.
 */
export const nativeCodeIssueRoutes = new Elysia().use(requireAuth).post(
  '/api/auth/native-code',
  async ({ body, auth, set }) => {
    // The challenge is base64url(sha256(verifier)) — fixed charset + length.
    // Sanitize before storing (same defensive instinct as the scheme check).
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(body.code_challenge)) {
      set.status = 400;
      return { error: 'invalid code_challenge' };
    }
    if (body.state.length < 8 || body.state.length > 256) {
      set.status = 400;
      return { error: 'invalid state' };
    }
    const issued = await issueNativeCode({
      userId: new ObjectId(auth.user.sub),
      codeChallenge: body.code_challenge,
      state: body.state,
      deviceLabel: body.device_label?.slice(0, 64) || 'Apple device',
    });
    return { code: issued.code };
  },
  {
    body: t.Object({
      code_challenge: t.String(),
      state: t.String(),
      device_label: t.Optional(t.String()),
    }),
  },
);
