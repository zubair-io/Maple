// src/api/src/routes/auth-lan-handoff.ts
//
// Web-to-web-LAN session handoff. Two endpoints:
//   POST /api/auth/lan-handoff         (authed) — the public-URL page issues a code
//   POST /api/auth/lan-handoff/redeem  (public) — the LAN-origin page redeems it
//
// Why this exists: WebAuthn (passkeys) requires a secure context — `https:`
// or exactly `http://localhost` — and a LAN IP like `192.168.1.42` over plain
// HTTP does not qualify. So a browser tab can only ever complete the passkey
// ceremony on the public HTTPS domain. This lets that already-authenticated
// tab hand its session to the SAME browser's LAN-origin tab (via a top-level
// redirect carrying only a short-lived one-time code — never tokens) without
// repeating the ceremony there.
import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { usersCollection } from '../db/client.ts';
import { signAccessToken, REFRESH_TTL_SECONDS } from '../auth/tokens.ts';
import { issueRefreshToken } from '../auth/refresh_store.ts';
import { issueLanHandoffCode, redeemLanHandoffCode } from '../auth/lan_handoff_store.ts';
import { requireAuth } from '../auth/middleware.ts';
import { rateLimit, clientIp } from '../auth/rate_limit.ts';

function jwtSecret(): string {
  const s = process.env.MAPLE_JWT_SECRET;
  if (!s || s.length < 16) throw new Error('MAPLE_JWT_SECRET unset or too short');
  return s;
}

/**
 * Authed issue. The public-URL page calls this once signed in, and redirects
 * to `http://<lan-ip>:<port>/?lan_handoff=<code>` with the result — never the
 * tokens themselves.
 *
 * Self-gating: `requireAuth` is `.use`d on this instance's own chain (same
 * pattern as `/native-code`), so its scoped derive stays contained when
 * mounted.
 */
export const lanHandoffIssueRoutes = new Elysia()
  .use(requireAuth)
  .post('/api/auth/lan-handoff', async ({ auth }) => {
    const issued = await issueLanHandoffCode({
      userId: new ObjectId(auth.user.sub),
      deviceLabel: 'Local network session',
    });
    return { code: issued.code };
  });

/**
 * Public redeem. The LAN-origin page, on load, finds `?lan_handoff=<code>` in
 * its URL and redeems it here for a fresh, independent session scoped to
 * THIS origin — including its own refresh cookie, so the LAN session
 * refreshes on its own from then on without bouncing back through the
 * public domain. No bearer required — this is how the LAN origin first
 * obtains tokens.
 *
 * The refresh cookie is set WITHOUT `secure` here — this route only ever
 * answers on the server's plain-HTTP LAN origin (a `Secure` cookie would
 * never be sent back over that connection, making it useless). The public
 * domain's own cookie (set by /login/verify, /register/verify, etc.) is
 * untouched and stays `secure: true`.
 */
export const lanHandoffRedeemRoutes = new Elysia().post(
  '/api/auth/lan-handoff/redeem',
  async ({ body, set, cookie, request }) => {
    const ip = clientIp(request);
    if (!rateLimit(`auth:${ip}`, 10, 60_000)) {
      set.status = 429;
      return { error: 'rate limited' };
    }
    const redeemed = await redeemLanHandoffCode(body.code);
    // Mirrors the user-lookup + access-token-sign shape in auth-native-code.ts's
    // redeem route (and auth.ts's own login/dev-login pair) — the codebase
    // already tolerates this per-route shape elsewhere rather than extracting
    // a shared helper.
    // fallow-ignore-next-line code-duplication
    if (!redeemed) {
      set.status = 400;
      return { error: 'invalid or expired code' };
    }
    const user = await (await usersCollection()).findOne({ _id: redeemed.userId });
    if (!user) {
      set.status = 401;
      return { error: 'user gone' };
    }
    const access_token = await signAccessToken(
      { sub: user._id.toHexString(), email: user.email, role: user.role },
      jwtSecret(),
    );
    const refresh = await issueRefreshToken(user._id, redeemed.deviceLabel, { secure: false });
    cookie.maple_refresh.set({
      value: refresh.raw,
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: REFRESH_TTL_SECONDS,
    });
    return {
      access_token,
      user: { id: user._id.toHexString(), email: user.email, role: user.role },
    };
  },
  { body: t.Object({ code: t.String() }) },
);
