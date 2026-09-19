// Native one-time auth-code store (#856) — now stored in SQLite (#3787).
//
// PKCE code-exchange for the Apple shell, replacing the legacy
// token-in-redirect-URL bridge. The web app (after a passkey ceremony
// establishes a session) issues a short-TTL, single-use code bound to a PKCE
// challenge + opaque state; the native app redeems it (with the verifier) for
// freshly-minted, device-scoped tokens. A raw refresh token therefore never
// rides in a redirect URL.
//
// The storage moved to `db/repos/auth.codes.repo.ts` under the same
// names. The two properties that matter are unchanged: a code is spendable
// exactly once, and a wrong verifier neither succeeds nor burns it, because
// the challenge match is still part of the compare-and-swap's predicate rather
// than a check afterwards.
//
// `pkceS256`, the code generator and the hashing live in `./handoff-code.ts`
// and are shared by both stores — one definition cannot drift from itself.
// `pkceS256` is re-exported here because the native auth routes import it from
// this path.

export {
  claimNativeCode,
  issueNativeCode,
  pkceS256,
  redeemNativeCode,
  type RedeemedNativeCode,
} from '../db/repos/auth.codes.repo.ts';
