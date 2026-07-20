// src/apple/Maple TV/RootTabView.swift
import Foundation
import MapleCloudKit
import SwiftUI
import UIKit

/// Connected root once a library is selected. `ConnectedScreen` presents
/// this as soon as `session.selectedLibraryID` resolves.
///
/// Navigation is menu-driven (there is no on-screen tab bar): the app
/// launches straight into the **Timeline** (`screen == .timeline`), the Siri
/// Remote's Menu button (Back) returns to the **Menu** hub from any content
/// screen, and Back again from the Menu backgrounds the app (tvOS default —
/// the menu attaches no `onExitCommand`, so the press isn't intercepted).
/// The Menu (`MenuScreen`) is where Timeline / Light Table / Search are
/// chosen and where Log Out (unpair, milestone C's `onForgotten`) lives, so
/// the content screens carry no navigation chrome of their own.
///
/// Idle screensaver (F3, #2121): `idleMonitor` fires after `Self.idleInterval`
/// of no observed Siri Remote activity, flipping `isScreensaverActive` to show
/// `LightTableScreen` full-bleed over — but *without* changing — the current
/// `screen`, so wherever the user was is still there once the screensaver is
/// dismissed. The monitor also observes `UIFocusSystem.didUpdateNotification`
/// so focus moves the focus engine resolves locally (arrow-keying a grid)
/// still count as activity. See `screensaverInputCapture` / `enterScreensaver`
/// / `exitScreensaver`.
struct RootTabView: View {
  let session: TVCloudSession
  let libraryID: String
  let libraryName: String
  let onForgotten: () -> Void

  /// The screen the user is on. Starts at `.timeline` (the app opens
  /// straight into it); Back moves it to `.menu`, and the menu's rows move
  /// it to a content screen. Never mutated by the screensaver — that's the
  /// point of keeping it separate from `isScreensaverActive`.
  @State private var screen: RootScreen = .timeline
  @State private var isScreensaverActive = false
  @State private var idleMonitor: IdleActivityMonitor?
  @FocusState private var isScreensaverCaptureFocused: Bool

  /// Token for the app-wide `UIFocusSystem.didUpdateNotification` observer,
  /// stored so `.onDisappear` can `removeObserver` it — same "arm on appear,
  /// tear down on disappear" discipline as `idleMonitor`.
  @State private var focusUpdateObserver: NSObjectProtocol?

  /// Default 3 minutes; overridable via `MAPLE_TV_IDLE_INTERVAL_SECONDS` in
  /// the process environment for fast manual/sim verification (same
  /// launch-environment pattern as `MAPLE_UITEST_FIXTURE`).
  private static var idleInterval: Duration {
    guard
      let raw = ProcessInfo.processInfo.environment["MAPLE_TV_IDLE_INTERVAL_SECONDS"],
      let seconds = Double(raw), seconds > 0
    else { return .seconds(180) }
    return .seconds(seconds)
  }

  var body: some View {
    ZStack {
      // The current screen stays mounted underneath the screensaver rather
      // than being swapped out for it — destroying e.g. `TimelineScreen`
      // would throw away its scroll position and loaded feed, forcing a
      // reload when the screensaver is dismissed. `.disabled` while the
      // screensaver is up pulls its focusable content out of the focus
      // engine's candidate set so the only thing a directional press can
      // land on is `screensaverInputCapture` (see `screensaverOverlay`).
      content
        .disabled(isScreensaverActive)

      if isScreensaverActive {
        screensaverOverlay
      }
    }
    .onChange(of: screen) { _, _ in handleInteraction() }
    .onAppear {
      let monitor = IdleActivityMonitor(interval: Self.idleInterval, onIdle: enterScreensaver)
      idleMonitor = monitor
      armIdleMonitor()
      focusUpdateObserver = NotificationCenter.default.addObserver(
        forName: UIFocusSystem.didUpdateNotification,
        object: nil,
        queue: .main
      ) { _ in
        handleFocusUpdate()
      }
    }
    .onDisappear {
      idleMonitor?.stop()
      idleMonitor = nil
      if let observer = focusUpdateObserver {
        NotificationCenter.default.removeObserver(observer)
      }
      focusUpdateObserver = nil
    }
  }

  @ViewBuilder
  private var content: some View {
    switch screen {
    case .menu:
      // No `.onExitCommand`: at the hub, Back is the tvOS default (background
      // the app).
      MenuScreen(
        libraryName: libraryName,
        onSelect: { screen = $0 },
        onForgotten: onForgotten
      )
    case .timeline:
      TimelineScreen(session: session, libraryID: libraryID, libraryName: libraryName)
        .onExitCommand { goToMenu() }
    case .lightTable:
      LightTableScreen(session: session, libraryID: libraryID)
        .onExitCommand { goToMenu() }
    case .search:
      SearchScreen(session: session, libraryID: libraryID)
        .onExitCommand { goToMenu() }
    }
  }

  private func goToMenu() {
    screen = .menu
  }

  /// The full-bleed screensaver drawn over the still-mounted `content`. Its
  /// own `LightTableScreen` runs the same ambient glide cycle and its opaque
  /// warm-paper background hides the screen underneath. `.disabled(true)`
  /// pulls its print cards out of the focus set — combined with the
  /// underlying screen being disabled too, the only focusable candidate left
  /// is `screensaverInputCapture`, so every directional press reaches its
  /// command handlers and dismisses the screensaver.
  private var screensaverOverlay: some View {
    ZStack {
      LightTableScreen(session: session, libraryID: libraryID)
        .disabled(true)
      screensaverInputCapture
    }
  }

  /// A transparent, full-screen focus target shown only in screensaver mode.
  /// It grabs focus the moment the screensaver appears, so its command
  /// handlers fire directly on it. The Siri Remote command handlers live
  /// *here* rather than on the root so they only intercept input while the
  /// screensaver is up: a directional move, a Menu (`.onExitCommand`), a
  /// Play-Pause, or a Select (`.onTapGesture`) all funnel through
  /// `handleInteraction()`, dismissing the screensaver.
  private var screensaverInputCapture: some View {
    Color.clear
      .contentShape(Rectangle())
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .focusable()
      .focused($isScreensaverCaptureFocused)
      .onAppear { isScreensaverCaptureFocused = true }
      .onMoveCommand { _ in handleInteraction() }
      .onExitCommand { handleInteraction() }
      .onPlayPauseCommand { handleInteraction() }
      .onTapGesture { handleInteraction() }
      .accessibilityHidden(true)
  }

  /// Fed by the screensaver's own command handlers, a `screen` change, and —
  /// via `handleFocusUpdate()` — every app-wide focus move. That last one is
  /// why arrow-keying grid cells (which the focus engine resolves locally and
  /// never bubbles up as an `onMoveCommand`) still counts as activity.
  private func handleInteraction() {
    if isScreensaverActive {
      exitScreensaver()
    } else {
      armIdleMonitor()
    }
  }

  /// Handler for the app-wide `UIFocusSystem.didUpdateNotification` observer.
  /// Fires on every focus move anywhere in the hierarchy — including moves a
  /// focusable descendant resolves locally without reaching `onMoveCommand`.
  ///
  /// Deliberately does **not** exit the screensaver: while it's active,
  /// `screensaverInputCapture` grabs focus for itself the instant it appears,
  /// which is itself a focus move that posts this notification — dismissing on
  /// it would kill the screensaver in the same frame it activated. Genuine
  /// dismissal is covered by the capture's own command handlers, so this only
  /// pokes the monitor, and only while the screensaver is not showing.
  private func handleFocusUpdate() {
    guard !isScreensaverActive else { return }
    armIdleMonitor()
  }

  private func armIdleMonitor() {
    // Paused while the user is already on the Light Table by choice — there's
    // nothing for the screensaver to usefully take over, and firing it there
    // would `.disabled(true)` the screen they're actively looking at.
    guard screen != .lightTable else {
      idleMonitor?.stop()
      return
    }
    idleMonitor?.poke()
  }

  private func enterScreensaver() {
    isScreensaverActive = true
  }

  private func exitScreensaver() {
    isScreensaverActive = false
    armIdleMonitor()
  }
}

#Preview {
  RootTabView(
    session: TVCloudSession(server: URL(string: "https://maple.local")!, onSignOut: {}),
    libraryID: "preview-library",
    libraryName: "My Photos",
    onForgotten: {}
  )
}
