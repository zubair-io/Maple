import Foundation
import MapleCloudKit

/// Services live for one authenticated Watch session; no RAW engine or disk image cache.
@MainActor
final class WatchSession {
  let folders: CloudFoldersClient
  let search: CloudSearchClient
  let memories: GeneratedSearchClient
  let images: WatchImageStore
  private let urlSession: URLSession
  private let ending: WatchSessionEnding
  private let server: URL

  init(server: URL, onSignOut: @escaping () -> Void) {
    self.server = server
    let ending = WatchSessionEnding()
    self.ending = ending
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.httpMaximumConnectionsPerHost = 2
    configuration.timeoutIntervalForRequest = 30
    let transport = URLSession(configuration: configuration)
    urlSession = transport
    // A refresh re-reads the keychain under TokenStore's refresh lock, so one
    // finishing after the pairing client cleared these credentials stops (#4873).
    let http = AuthenticatedHTTPClient(
      server: server, urlSession: transport,
      tokensProvider: { try? TokenStore.load(server: server) },
      onTokensRefreshed: { try CloudTokenPersistence.persistRotated($0, server: server) },
      onSignOut: {
        guard ending.claim() else { return }
        transport.invalidateAndCancel()
        Task { @MainActor in onSignOut() }
      },
      refreshExecutor: ExpiringActivityRefreshExecutor()
    )
    folders = CloudFoldersClient(server: server, httpClient: http)
    search = CloudSearchClient(server: server, httpClient: http)
    memories = GeneratedSearchClient(server: server, httpClient: http)
    images = WatchImageStore(
      server: server, client: CloudThumbClient(server: server, httpClient: http))
  }

  /// Ends the server session best-effort; the pairing client forgets the local
  /// credentials. A failed logout leaves the session revocable from web Settings.
  func disconnect() {
    guard ending.claim() else { return }
    let tokens = try? TokenStore.load(server: server)
    urlSession.invalidateAndCancel()
    Task { await images.invalidate() }
    guard let tokens else { return }
    let server = server
    Task {
      try? await AuthClient(server: server).logout(
        accessToken: tokens.access, refreshToken: tokens.refresh)
    }
  }

  deinit {
    urlSession.invalidateAndCancel()
  }
}
