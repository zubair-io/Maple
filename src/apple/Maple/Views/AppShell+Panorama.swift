// AppShell+Panorama.swift — opening, finishing and dismissing the panorama
// merge view (#1236), choosing where it runs (#5488), and keeping it from
// being swiped away mid-flow (#5662).

import MapleCloudKit
import MapleCore
import SwiftUI

@MainActor
extension AppShell {
  // MARK: - Panorama merge actions (M2, #1236)

  /// Open the panorama merge view with the currently-selected assets.
  /// Only called when `browseVM.canMergePanorama` is true. Frames that all
  /// live on one Maple server can stitch there; frames with no file on this
  /// device can only stitch there, so that is where the sheet starts.
  func openPanoramaMerge() {
    guard browseVM.canMergePanorama else { return }
    let assets = browseVM.selectedAssets(sessions: sessions)
    panoServerStitcher = ServerPanoStitcher.server(for: assets).map(makePanoServerStitcher)
    panoMergeSession.reset()
    let onDevice = assets.allSatisfy { $0.primaryURL != nil }
    panoMergeSession.downloadRoute = onDevice ? nil : makePanoDownloadRoute(for: assets)
    let serverOnly: (any PanoStitching)? = onDevice ? nil : panoServerStitcher
    panoMergeSession.use(serverOnly ?? panoDeviceStitcher)
    mode = .panoramaMerge
  }

  /// Done after a stitch. An on-device result is a local file the grid can
  /// show at once; a server result was imported into the server's library
  /// beside the frames, so the listing is reloaded to pick it up.
  func completePanoramaMerge(_ result: PanoResult) {
    guard !result.storedOnServer else {
      Task { await browseVM.retryLastLoad() }
      return
    }
    browseVM.injectPanoResult(url: result.outputURL)
  }

  /// Dismiss the panorama merge view and return to browse. Exits select
  /// mode so the grid resets to normal tap-to-open behaviour.
  ///
  /// Always cancels the in-flight stitch, so none leaks after the view is
  /// gone — including a server stitch left running by a lost connection,
  /// which Try Again would rejoin. The view only reaches here after the user
  /// confirmed discarding a running or finished stitch (#5662), and iPhone
  /// and iPad present it as a cover no swipe can close.
  func dismissPanoramaMerge() {
    releasePanoramaMerge()
    mode = .browse
    browseVM.exitSelectMode()
  }

  /// Also runs when something else (a deep link, reveal) moves `mode` away
  /// while the view is up, so a stitch is never left running with no UI.
  func releasePanoramaMerge() {
    panoMergeSession.cancel()
    panoServerStitcher?.abandon()
    panoMergeSession.downloadRoute?.download.cancel()
    panoMergeSession.downloadRoute = nil
  }

  var panoMergeIsPresented: Binding<Bool> {
    Binding(
      get: { mode == .panoramaMerge },
      set: { if !$0 { dismissPanoramaMerge() } }
    )
  }

  var panoMergeView: some View {
    PanoMergeView(
      assets: browseVM.selectedAssets(sessions: sessions),
      source: browseVM.currentSource,
      session: panoMergeSession,
      deviceStitcher: panoDeviceStitcher,
      serverStitcher: panoServerStitcher,
      onDismiss: { dismissPanoramaMerge() },
      onComplete: { result in completePanoramaMerge(result) },
      onOpenPanoSettings: {
        dismissPanoramaMerge()
        showAppSettings(initialTab: .pano)
      }
    )
  }

  /// Frames on Maple servers can be downloaded into a temporary cache and
  /// stitched here with any already on this device (#5489); the result
  /// goes back to the first cloud frame's server.
  private func makePanoDownloadRoute(for assets: [AssetRef]) -> PanoDownloadRoute? {
    let catalogs = assets.compactMap(\.catalog)
    let reachable = assets.allSatisfy { $0.primaryURL != nil || $0.catalog != nil }
    guard reachable, let first = catalogs.first else { return nil }
    let sources = Dictionary(
      Set(catalogs.map(\.serverID)).map { server in
        (
          server,
          CloudSource(
            server: LocalNetworkResolver.shared.effectiveURL(for: server), identity: server,
            folderID: "", libraryPath: "", httpClient: makeAuthenticatedHTTPClient(server: server))
        )
      },
      uniquingKeysWith: { kept, _ in kept })
    let download = PanoFrameDownload(fetcher: CloudPanoFrameFetcher(sources: sources))
    let effective = LocalNetworkResolver.shared.effectiveURL(for: first.serverID)
    let http = makeAuthenticatedHTTPClient(server: first.serverID)
    let remote = RemoteCatalog(http: http, server: effective)
    let folders = CloudFoldersClient(server: effective, httpClient: http)
    let device = RustPanoStitcher(outputDirectory: download.outputDirectory)
    return PanoDownloadRoute(download: download) { cloudFrames, localFrames in
      DownloadedFramesStitcher(
        device: device, cloudFrames: cloudFrames, localFrames: localFrames,
        addToLibrary: { result in
          try await PanoServerUpload.add(
            result, beside: first, remote: remote, folders: folders)
        },
        finished: { download.cancel() })
    }
  }

  private func makePanoServerStitcher(_ server: URL) -> ServerPanoStitcher {
    ServerPanoStitcher(
      jobs: PanoServerClient(
        server: server, httpClient: makeAuthenticatedHTTPClient(server: server)))
  }
}

extension View {
  func panoMergePresentation<Content: View>(
    isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> Content
  ) -> some View {
    #if os(iOS)
      fullScreenCover(isPresented: isPresented, content: content)
    #else
      sheet(isPresented: isPresented) {
        content().frame(minWidth: 560, minHeight: 480)
      }
    #endif
  }
}
