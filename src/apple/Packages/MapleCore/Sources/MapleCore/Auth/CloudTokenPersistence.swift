// src/apple/Packages/MapleCore/Sources/MapleCore/Auth/CloudTokenPersistence.swift
import Foundation

/// Persistence for a rotated cloud token pair — the standard `onTokensRefreshed`
/// handler for every in-app `AuthenticatedHTTPClient`.
///
/// Saving to the app Keychain (`TokenStore`) alone is not enough. The File
/// Provider and QuickLook extensions run in **separate processes** with their
/// own token store (`FileProviderTokensStore`, a shared-access-group keychain
/// item). When the main app rotates the refresh token without mirroring it, the
/// extension keeps a now-superseded token; its next refresh presents that dead
/// token, the server reads it as refresh-token reuse and revokes the whole
/// device family (`revokeFamily`), and every process — app included — is signed
/// out. Mirroring on **every** rotation keeps the extension's copy current, which
/// is exactly the invariant `FileProviderDomainController.mirrorTokens` documents
/// ("call on every main-app token refresh") but which the hot-path refresh
/// handlers previously skipped — they only saved to `TokenStore`.
///
/// This is the app→extension direction. Extension→app is a known remaining gap:
/// `TokenStore` is private to the app container, so an extension-initiated
/// rotation can't be written back to it; recovering from that edge still needs a
/// re-sign-in, or a future unification onto a single shared store.
public enum CloudTokenPersistence {
  /// Persist `tokens` for `server` to the app Keychain and mirror them into the
  /// File Provider's shared store. Safe to call when no File Provider domain is
  /// registered — the mirror is a no-op in that case.
  public static func persistRotated(_ tokens: AuthTokens, server: URL) {
    try? TokenStore.save(tokens, server: server)
    Task { await FileProviderDomainController().mirrorTokens(serverURL: server) }
  }

  /// Clear `server`'s tokens from the app Keychain AND the mirrored File Provider
  /// store — the symmetric counterpart to `persistRotated`. A forced sign-out
  /// that cleared only the app Keychain would leave the extension polling with
  /// stale mirrored credentials until it independently failed; `mirrorTokens`
  /// with an empty `TokenStore` removes the shared copy too.
  public static func clear(server: URL) {
    TokenStore.clear(server: server)
    Task { await FileProviderDomainController().mirrorTokens(serverURL: server) }
  }
}
