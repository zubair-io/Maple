/**
 * CRUD for `apns_device_tokens` rows (#1025). Registration is per (user,
 * device) — NOT per library. A File Provider domain is one per connected
 * SERVER (`FileProviderDomainController.domainIdentifier(for:)` keys on
 * scheme+host+port only), and every library registered on that server
 * surfaces as a sub-tree inside that one domain
 * (`FileProviderIdentifier.folder(folderID:relativePath:)` addresses a
 * library's contents as an ITEM within the domain, not a domain of its
 * own). So a device holds exactly one push registration per server it has
 * mounted, and a change to any library on that server should wake it —
 * there is no per-library push channel to scope to on the Apple side.
 *
 * ## Where the queries went (#3787)
 *
 * Every database verb now lives in `db/repos/apns-devices.repo.ts`
 * and is re-exported below by name. The names are spelled out one per line
 * rather than forwarded wholesale, so a signature that changed on the SQLite
 * side fails to compile here instead of being swapped in silently.
 *
 * {@link normalizeDeviceToken} stays, because it is a regular expression over
 * a string with no database in it — the same treatment `quantizedKey` gets in
 * the geocode cache. `routes/apns-devices.ts` keeps importing it from here.
 */

export {
  listAllDeviceTokens,
  listDeviceTokensForUser,
  pruneDeviceTokens,
  registerDeviceToken,
  unregisterDeviceToken,
} from '../db/repos/apns-devices.repo.ts';

/**
 * APNs device tokens are hex-encoded bytes (`PKPushCredentials.token`,
 * hex-formatted client-side): exactly 64 hex characters for the modern
 * 32-byte token, which is the only format any Maple client can ever send
 * — the deployment floor is iOS 26.0 / macOS 14.0, well past any of
 * Apple's historical shorter/variable-length token eras, so there is no
 * legacy shape to stay lenient for. Trims whitespace and lowercases
 * before validating so `AbCd…` and `abcd…` (or a trailing newline pasted
 * into a debug tool) register as the SAME device rather than silently
 * creating a second stored row that never matches what APNs reports back
 * on prune. Returns `null` for anything that doesn't look like a real
 * token — callers turn that into a 400 rather than storing a malformed
 * value APNs will just keep rejecting.
 */
const DEVICE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function normalizeDeviceToken(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  return DEVICE_TOKEN_PATTERN.test(normalized) ? normalized : null;
}
