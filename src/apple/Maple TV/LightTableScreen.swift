// src/apple/Maple TV/LightTableScreen.swift
import MapleCloudKit
import SwiftUI
import UIKit

/// The Light Table tab (#2121 F2): MapleCloudKit's shared `LightTableView`
/// on Maple TV's fixed 1920×1080 stage, fed by the TV thumbnail pipeline.
/// Unlike every other Maple TV screen it follows the system appearance
/// rather than the app's forced dark: warm paper in Light, Maple's dark
/// palette in Dark.
struct LightTableScreen: View {
  let session: TVCloudSession
  let libraryID: String

  @State private var viewModel: LightTableViewModel
  @State private var systemColorScheme = Self.currentSystemColorScheme()

  init(session: TVCloudSession, libraryID: String) {
    self.session = session
    self.libraryID = libraryID
    _viewModel = State(
      initialValue: LightTableViewModel(
        libraryID: libraryID,
        searchClient: session.searchClient,
        generatedSearchClient: session.generatedSearchClient
      ))
  }

  var body: some View {
    LightTableView(
      viewModel: viewModel,
      metrics: .television,
      accent: MapleTVTheme.primary,
      darkPalette: .mapleTV,
      prefetch: { asset in
        await TVRemoteImage.prefetchThumb(
          server: session.server, absPath: asset.abs_path,
          thumbClient: session.thumbClient, thumbCache: session.thumbCache)
      },
      printImage: { asset in
        TVRemoteImage(
          server: session.server,
          absPath: asset.abs_path,
          kind: .thumb,
          thumbClient: session.thumbClient,
          thumbCache: session.thumbCache,
          // The print is a fixed square; non-square photos sit within it on
          // the mat rather than being cropped to the frame.
          contentMode: .fit,
          accessibilityLabel: asset.filename
        )
      }
    )
    .environment(\.colorScheme, systemColorScheme)
    .task {
      while !Task.isCancelled {
        systemColorScheme = Self.currentSystemColorScheme()
        try? await Task.sleep(for: .seconds(1))
      }
    }
    .onAppear {
      // The Light Table is a deliberately no-interaction ambient view, so
      // tvOS would otherwise judge the box "idle" and drop its own system
      // screensaver over Maple. Hold the idle timer off while it's showing.
      UIApplication.shared.isIdleTimerDisabled = true
    }
    .onDisappear {
      UIApplication.shared.isIdleTimerDisabled = false
    }
  }

  /// `MapleTVApp` forces the app dark, which `\.colorScheme` reports here;
  /// only the screen's traits still carry the Apple TV's own Light/Dark
  /// setting, and the screen offers no change notification, hence the poll.
  private static func currentSystemColorScheme() -> ColorScheme {
    let screen = UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.screen }
      .first
    return screen?.traitCollection.userInterfaceStyle == .light ? .light : .dark
  }
}

// No `#Preview` here: `TVCloudSession` has no lightweight `.preview()`
// factory (real Keychain-backed token lookup) — matches
// `TimelineScreen`/`PhotoViewerScreen`, neither of which carry one for
// the same reason.

extension LightTablePalette {
  static let mapleTV = LightTablePalette(
    paperTop: MapleTVTheme.surface, paperBottom: MapleTVTheme.background,
    ink: MapleTVTheme.textPrimary, mat: MapleTVTheme.textPrimary)
}
