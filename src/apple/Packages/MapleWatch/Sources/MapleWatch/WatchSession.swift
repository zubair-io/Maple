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
  private let credentials: WatchCredentialLease
  private let server: URL

  init(server: URL, onSignOut: @escaping () -> Void) {
    self.server = server
    let credentials = WatchCredentialLease()
    self.credentials = credentials
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.httpMaximumConnectionsPerHost = 2
    configuration.timeoutIntervalForRequest = 30
    let transport = URLSession(configuration: configuration)
    urlSession = transport
    let http = AuthenticatedHTTPClient(
      server: server, urlSession: transport,
      tokensProvider: { try? credentials.whileActive { try TokenStore.load(server: server) } },
      onTokensRefreshed: { tokens in
        try credentials.whileActive { try TokenStore.save(tokens, server: server) }
      },
      onSignOut: {
        guard credentials.invalidate({ TokenStore.clear(server: server) }) else { return }
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

  func disconnect() {
    credentials.invalidate { TokenStore.clear(server: server) }
    urlSession.invalidateAndCancel()
    Task { await images.invalidate() }
  }

  deinit {
    credentials.invalidate()
    urlSession.invalidateAndCancel()
  }
}
