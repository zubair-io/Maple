// src/apple/Maple TV/PhotoViewerScreen.swift
import MapleCloudKit
import SwiftUI

/// Full-screen photo viewer (#2102 D6). Presented over `TimelineScreen`
/// when a grid cell is selected; navigates left/right within `assets` —
/// the Timeline's currently-loaded result set (flattened day sections),
/// NOT a fresh fetch of its own. No cross-day paging beyond what's
/// already loaded, by design (v1, Global Constraint).
///
/// Each asset shows its already-cached grid thumbnail instantly, then
/// crossfades to the sharp ~1280px preview once it's fetched — no
/// flash, because the preview layer stays transparent until
/// `TVRemoteImage`'s `onPhaseChange` reports it loaded (see that file).
/// The immediate neighbors (±1) are prefetched into the decoded-image
/// cache on every index change so a swipe in either direction is
/// instant far more often than not.
struct PhotoViewerScreen: View {
  let assets: [SearchAsset]
  let session: TVCloudSession
  /// Called with whichever asset is on screen at the moment the viewer
  /// is dismissed (Menu/back) — NOT necessarily the asset that was
  /// originally tapped, since the user may have swiped elsewhere first.
  /// `TimelineScreen` uses this to move grid focus back to that asset's
  /// cell rather than the one that opened the viewer.
  let onDismiss: (SearchAsset) -> Void

  @State private var currentIndex: Int
  /// The id of the asset whose `.preview` layer has finished loading —
  /// compared against the CURRENT asset (not the one a stale callback
  /// closure captured) so a slow fetch for an asset the user already
  /// swiped away from can't pop the crossfade in late (identity guard,
  /// Global Constraint #3).
  @State private var previewReadyAssetID: String?
  @FocusState private var isFocused: Bool
  @Environment(\.dismiss) private var dismiss

  init(assets: [SearchAsset], startIndex: Int, session: TVCloudSession, onDismiss: @escaping (SearchAsset) -> Void) {
    self.assets = assets
    self.session = session
    self.onDismiss = onDismiss
    let clamped = assets.isEmpty ? 0 : min(max(startIndex, 0), assets.count - 1)
    _currentIndex = State(initialValue: clamped)
  }

  private var currentAsset: SearchAsset? {
    assets.indices.contains(currentIndex) ? assets[currentIndex] : nil
  }

  var body: some View {
    ZStack {
      MapleTVTheme.background.ignoresSafeArea()

      if let currentAsset {
        mediaView(for: currentAsset)
          .accessibilityIdentifier("media-viewer")

        captionOverlay(for: currentAsset)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .ignoresSafeArea()
    .focusable(currentAsset?.isVideo != true)
    .focused($isFocused)
    .onAppear { isFocused = currentAsset?.isVideo != true }
    .onChange(of: currentIndex) { _, _ in
      isFocused = currentAsset?.isVideo != true
    }
    .onMoveCommand(perform: handleMove)
    .onExitCommand(perform: dismissViewer)
    .task(id: currentIndex) { await prefetchNeighbors() }
  }

  // MARK: - Image layers

  @ViewBuilder
  private func mediaView(for asset: SearchAsset) -> some View {
    if asset.isVideo {
      TVVideoPlayerView(asset: asset, videoClient: session.videoClient)
    } else {
      imageStack(for: asset)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Photo viewer")
        .accessibilityValue(Self.captionText(for: asset))
    }
  }

  private func imageStack(for asset: SearchAsset) -> some View {
    ZStack {
      TVRemoteImage(
        server: session.server,
        absPath: asset.abs_path,
        kind: .thumb,
        thumbClient: session.thumbClient,
        thumbCache: session.thumbCache,
        contentMode: .fit,
        accessibilityLabel: asset.filename
      )

      TVRemoteImage(
        server: session.server,
        absPath: asset.abs_path,
        kind: .preview,
        thumbClient: session.thumbClient,
        thumbCache: session.thumbCache,
        contentMode: .fit,
        accessibilityLabel: asset.filename,
        onPhaseChange: { loaded in
          // `currentAsset` is read live, not captured, so a callback
          // that fires after the user has already swiped to a
          // different asset sees a mismatch here and is dropped —
          // it never sets `previewReadyAssetID` to an asset that's no
          // longer on screen.
          guard asset.id == currentAsset?.id else { return }
          previewReadyAssetID = loaded ? asset.id : nil
        }
      )
      .opacity(previewReadyAssetID == asset.id ? 1 : 0)
      .animation(.easeInOut(duration: 0.18), value: previewReadyAssetID)
    }
  }

  // MARK: - Caption

  /// Visual-only caption bar. The same text is exposed as the
  /// `imageStack`'s `accessibilityValue` above, so this layer is hidden
  /// from the accessibility tree rather than doubling up the
  /// announcement.
  private func captionOverlay(for asset: SearchAsset) -> some View {
    VStack {
      Spacer()
      VStack(alignment: .leading, spacing: 6) {
        Text(asset.filename)
          .font(.system(size: 22, weight: .semibold))
          .foregroundStyle(MapleTVTheme.textPrimary)
          .lineLimit(1)
          .truncationMode(.middle)

        HStack(spacing: 16) {
          if let rating = asset.rating, rating > 0 {
            HStack(spacing: 2) {
              ForEach(0..<rating, id: \.self) { _ in
                Image(systemName: "star.fill")
                  .font(.system(size: 13))
                  .foregroundStyle(MapleTVTheme.star)
              }
            }
          }
          if let dateText = Self.captureDateText(asset.captured_at) {
            Text(dateText)
              .font(.system(size: 16))
              .foregroundStyle(MapleTVTheme.textMuted)
          }
          if let place = Self.placeText(asset.place) {
            Text(place)
              .font(.system(size: 16))
              .foregroundStyle(MapleTVTheme.textMuted)
          }
        }
      }
      .padding(.horizontal, 72)
      .padding(.vertical, 28)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(MapleTVTheme.background.opacity(0.75))
    }
    .accessibilityHidden(true)
  }

  private static func captionText(for asset: SearchAsset) -> String {
    var parts = [asset.filename]
    if let rating = asset.rating, rating > 0 {
      parts.append(rating == 1 ? "1 star" : "\(rating) stars")
    }
    if let dateText = captureDateText(asset.captured_at) {
      parts.append(dateText)
    }
    if let place = placeText(asset.place) {
      parts.append(place)
    }
    return parts.joined(separator: ", ")
  }

  private static func captureDateText(_ isoString: String?) -> String? {
    guard let isoString, let date = parseTimelineISO8601(isoString) else { return nil }
    return date.formatted(date: .abbreviated, time: .shortened)
  }

  /// Mirrors `TimelineScreen.placeText(_:)`'s locality-first, display-name
  /// fallback shape, scoped to a single asset rather than a day's worth.
  private static func placeText(_ place: SearchAssetPlace?) -> String? {
    guard let place else { return nil }
    if let rollups = place.rollups {
      let parts = [rollups.locality, rollups.region ?? rollups.country_code]
        .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
      if !parts.isEmpty { return parts.joined(separator: ", ") }
    }
    let displayName = place.display_name?.trimmingCharacters(in: .whitespaces)
    return (displayName?.isEmpty == false) ? displayName : nil
  }

  // MARK: - Navigation

  private func handleMove(_ direction: MoveCommandDirection) {
    switch direction {
    case .left: step(by: -1)
    case .right: step(by: 1)
    default: break
    }
  }

  /// Clamped at both ends — no wrap, no out-of-bounds (Global Constraint).
  private func step(by delta: Int) {
    let candidate = currentIndex + delta
    guard assets.indices.contains(candidate) else { return }
    currentIndex = candidate
  }

  private func dismissViewer() {
    if let currentAsset { onDismiss(currentAsset) }
    dismiss()
  }

  // MARK: - Prefetch

  /// Warms the decoded-image cache for the immediate neighbors so a
  /// swipe in either direction is usually instant. Deliberately ±1, not
  /// wider — `.preview` bypasses the disk cache (see `TVRemoteImage`'s
  /// header), so every prefetched neighbor is a live network fetch.
  /// Structured under `withTaskGroup` (a child of this `.task(id:)`) so
  /// a rapid swipe burst cancels superseded prefetches instead of piling
  /// up requests.
  private func prefetchNeighbors() async {
    let server = session.server
    let thumbClient = session.thumbClient
    let neighborPaths = [currentIndex - 1, currentIndex + 1]
      .filter(assets.indices.contains)
      .filter { !assets[$0].isVideo }
      .map { assets[$0].abs_path }
    guard !neighborPaths.isEmpty else { return }

    await withTaskGroup(of: Void.self) { group in
      for absPath in neighborPaths {
        group.addTask {
          await TVRemoteImage.prefetchPreview(server: server, absPath: absPath, thumbClient: thumbClient)
        }
      }
    }
  }
}

// No `#Preview` here: `TVCloudSession` builds a real `AuthenticatedHTTPClient`
// (Keychain-backed token lookup, `CloudServerRegistry` reads) and has no
// lightweight `.preview()` factory the way `CloudThumbClient`/`CloudThumbCache`
// do — matching `ConnectedScreen`/`TimelineScreen`/`LibraryPickerScreen`,
// none of which carry a `#Preview` for the same reason.
