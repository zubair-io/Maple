// LAN handoff one-time code store — now stored in SQLite (#3787).
//
// A signed-in web session on the public URL mints a short-TTL, single-use
// code; the SAME browser redeems it moments later on the server's LAN
// address (after `window.location` navigates there) for a fresh session —
// without repeating the WebAuthn ceremony, which requires a secure context
// the plain-HTTP LAN origin can't provide. See routes/auth-lan-handoff.ts.
//
// No PKCE (unlike native_code_store.ts): the native flow keeps the verifier
// in the app's memory, only sending the CODE over the transport an attacker
// could intercept. Here there's no such side-channel — code and any verifier
// would travel together in the same redirect URL — so a bare single-use,
// short-TTL code carries the same guarantee.
//
// Both handoff tables are ported together in
// `db/repos/auth.codes.repo.ts`, because they are the same mechanism
// with and without PKCE. The single-use guarantee survives the move: what was
// one `findOneAndUpdate` is now one `UPDATE` carrying the same conditions in
// its `WHERE`, and a row count of 1 is what says this caller spent the code.

export { issueLanHandoffCode, redeemLanHandoffCode } from '../db/repos/auth.codes.repo.ts';
