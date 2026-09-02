// src/apple/Maple TV/PhotoViewerScreen.swift
import MapleCloudKit
import SwiftUI

/// Full-screen photo viewer (#2102 D6). Presented over `TimelineScreen`
/// when a grid cell is selected; navigates left/right within `assets` —
/// the Timeline's currently-loaded result set (flattened day sections),
/// NOT a fresh fetch of its own. No cross-day paging beyond what's
/// already loaded, by design (v1, Global Constraint).
///
/// The viewer owns ONE image layer and swaps the `UIImage` in it, rather
/// than stacking a `.thumb` `TVRemoteImage` under a `.preview` one and
/// cross-fading their opacities. That older shape produced the two visible
/// artefacts this screen was reported for:
///
///   * **Stretching.** Both assets shared one view identity, so when the
///     `UIImage` swapped under a `.resizable().aspectRatio(.fit)` image with
///     an animation in scope, SwiftUI interpolated the old photo's frame into
///     the new one's — a portrait visibly morphing into a landscape.
///   * **Flicker.** `TVRemoteImage` paints an opaque surface while loading,
///     and its `.task` reset to `.loading` on every asset change, so each
///     step flashed grey even when the next photo was already in the
///     decoded-image cache.
///
/// Now: `displayed` holds whatever is currently on screen and is only ever
/// replaced by a *resolved* image, so the outgoing photo stays up until the
/// incoming one is ready — never a placeholder in between. Each asset's image
/// carries its own `.id`, so the two never share geometry and a cross-dissolve
/// is the only thing that animates. A warm thumbnail paints immediately and
/// is replaced in place by the sharp ~1280px preview (same aspect ratio, so
/// the swap doesn't move anything). The ±2 neighbors are prefetched on every
/// index change, so a held-down left/right stays ahead of the viewer.
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
  /// The photo on screen right now. Deliberately survives a move to another
  /// asset: it is replaced only once that asset has an image to show, so a
  /// slow fetch leaves the previous photo up instead of a grey placeholder.
  @State private var displayed: DisplayedImage?
  /// Set when the current asset genuinely has no image to show — only then
  /// does the viewer replace a good photo with a failure glyph.
  @State private var failedAssetID: String?

  /// A resolved image and the asset it belongs to. `isPreview` distinguishes
  /// the stopgap thumbnail from the sharp preview tier, so a thumbnail that
  /// painted first can be upgraded in place while an already-sharp image is
  /// left alone.
  private struct DisplayedImage {
    let assetID: String
    let image: UIImage
    let isPreview: Bool
  }
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
    .task(id: currentIndex) { await showCurrentAsset() }
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

  /// One image layer, cross-dissolving between assets. `.id(assetID)` is what
  /// keeps the stretch away: each asset's image is its own view, so SwiftUI
  /// dissolves one into the other instead of animating a single image's frame
  /// from the old photo's shape to the new one's.
  @ViewBuilder
  private func imageStack(for asset: SearchAsset) -> some View {
    ZStack {
      if let displayed {
        Image(uiImage: displayed.image)
          .resizable()
          .aspectRatio(contentMode: .fit)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .id(displayed.assetID)
          .transition(.opacity)
      }

      if failedAssetID == asset.id {
        Image(systemName: "photo")
          .font(.system(size: 64))
          .foregroundStyle(MapleTVTheme.textMuted)
          .transition(.opacity)
      }
    }
    .animation(.easeInOut(duration: 0.22), value: displayed?.assetID)
    .animation(.easeInOut(duration: 0.22), value: failedAssetID)
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

  // MARK: - Loading

  /// Resolve an image for the current asset and put it on screen. Runs as a
  /// `.task(id: currentIndex)`, so moving on cancels a fetch still in flight
  /// for the asset the user just left.
  ///
  /// Nothing here clears `displayed` first. That is the whole point: while
  /// this is resolving, the previous photo stays up, which is what makes a
  /// left/right step read as one cross-dissolve rather than
  /// photo → placeholder → photo.
  @MainActor
  private func showCurrentAsset() async {
    guard let asset = currentAsset, !asset.isVideo else { return }
    if displayed?.assetID == asset.id, displayed?.isPreview == true { return }
    failedAssetID = nil

    let server = session.server

    // Already-warm preview (the common case — the neighbour prefetch put it
    // there): straight to the sharp image, no intermediate state at all.
    if let preview = TVRemoteImage.cachedImage(server: server, absPath: asset.abs_path, kind: .preview) {
      displayed = DisplayedImage(assetID: asset.id, image: preview, isPreview: true)
      return
    }

    // Otherwise paint the grid thumbnail if we have one decoded already. It
    // is soft at full screen, but it is the right photo, instantly, and the
    // preview replaces it in place below — same aspect ratio, so the upgrade
    // doesn't move anything on screen.
    if let thumb = TVRemoteImage.cachedImage(server: server, absPath: asset.abs_path, kind: .thumb) {
      displayed = DisplayedImage(assetID: asset.id, image: thumb, isPreview: false)
    }

    let preview = await TVRemoteImage.loadPreview(
      server: server,
      absPath: asset.abs_path,
      thumbClient: session.thumbClient
    )
    // The user may have moved on during the fetch; `.task(id:)` cancellation
    // handles the common case, but re-check identity before touching shared
    // view state either way.
    guard !Task.isCancelled, currentAsset?.id == asset.id else { return }

    guard let preview else {
      // A genuine dead end for THIS asset. If the stopgap thumbnail landed
      // above, keep it — it is the right photo. Otherwise what's on screen
      // belongs to the asset the viewer just left, and leaving it up would
      // show one photo while claiming to be on another, so it goes and the
      // failure glyph stands alone.
      if displayed?.assetID != asset.id {
        displayed = nil
        failedAssetID = asset.id
      }
      return
    }
    displayed = DisplayedImage(assetID: asset.id, image: preview, isPreview: true)
  }

  // MARK: - Prefetch

  /// Warms the decoded-image cache around the current asset so a step in
  /// either direction is usually instant. `.preview` bypasses the disk cache
  /// (see `TVRemoteImage`'s header), so every prefetched neighbour is a live
  /// network fetch — ±2 rather than a wide window, which is enough to stay
  /// ahead of a held-down left/right without turning a browse into a flood of
  /// requests. Structured under `withTaskGroup` (a child of this `.task(id:)`)
  /// so a rapid burst cancels superseded prefetches instead of piling up.
  private func prefetchNeighbors() async {
    let server = session.server
    let thumbClient = session.thumbClient
    let neighborPaths = [currentIndex - 2, currentIndex - 1, currentIndex + 1, currentIndex + 2]
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
