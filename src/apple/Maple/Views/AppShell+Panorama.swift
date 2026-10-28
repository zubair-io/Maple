// AppShell+Panorama.swift — opening, finishing and dismissing the panorama
// merge sheet (#1236), and choosing where it runs (#5488).

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
    let serverOnly: (any PanoStitching)? = onDevice ? nil : panoServerStitcher
    panoMergeSession.use(serverOnly ?? panoDeviceStitcher)
    mode = .panoramaMerge
  }

  /// Done after a stitch. An on-device result is a local file the grid can
  /// show at once; a server result was imported into the server's library
  /// beside the frames, so the listing is reloaded to pick it up.
  func completePanoramaMerge(_ result: PanoResult) {
    guard result.serverAssetID == nil else {
      Task { await browseVM.retryLastLoad() }
      return
    }
    browseVM.injectPanoResult(url: result.outputURL)
  }

  /// Dismiss the panorama merge view and return to browse. Exits select
  /// mode so the grid resets to normal tap-to-open behaviour.
  ///
  /// Always cancels the in-flight stitch, regardless of how the sheet is
  /// dismissed (Cancel/Done button OR system swipe-down / Escape gesture).
  /// The `.sheet(isPresented:set:)` binding routes ALL dismissal paths here,
  /// so the stitch can never leak after the sheet is gone — including a server
  /// stitch left running by a lost connection, which Try Again would rejoin.
  func dismissPanoramaMerge() {
    panoMergeSession.cancel()
    panoServerStitcher?.abandon()
    mode = .browse
    browseVM.exitSelectMode()
  }

  private func makePanoServerStitcher(_ server: URL) -> ServerPanoStitcher {
    ServerPanoStitcher(
      jobs: PanoServerClient(server: server, httpClient: makeAuthenticatedHTTPClient(server: server)))
  }
}
