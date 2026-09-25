// PreviewView.swift — fast static-image Preview surface (Fast Preview epic,
// design doc 2026-07-06-fast-preview-and-phone-card-editor-design.md §1/§2/§4/§6).
//
// The lightweight surface inserted between the grid and the heavy editor. A
// grid tap lands HERE, not in the editor; the editor is reachable only via the
// Edit button. The whole point is speed:
//
//   • It creates NO render pipeline. It mounts no interactive GPU/CPU canvas
//     and no zoom controller. It paints a cached JPEG through the SAME
//     `ThumbnailProvider` / `ThumbnailLoader` path the grid + filmstrip already
//     use — so opening a photo paints in ~1 frame and never blocks on the RAW
//     pipeline. Once the thumbnail is on screen, `ThumbnailProvider.preview`
//     swaps in the display tier (spec §3 / slice A1): `.maple/previews` 1600 px
//     for local assets, `/api/fs/preview` 1280 px for Maple Cloud, PHImageManager
//     high-quality for PhotoKit.
//   • Info's rating and flag controls reuse the asset's `EditSession` (created
//     lazily by the grid's `ensureSession`; `EditSession.init` allocates a
//     pipeline object but does NOT decode or render — the heavy work is
//     `ensureRenderStarted()`, which only the editor calls). Preview never
//     calls it, so those affordances cost nothing.
//
// Layout (spec §4):
//   ┌──────────────────────────────────────────────┐
//   │  ‹  filename                Edit       Info    │  ← one floating header
//   │  ┌──────┐                                     │
//   │  │ film │            FIT IMAGE                │  ← body + left `FilmstripRail`
//   │  │ rail │                                     │    (regular — the editor's rail, #3402)
//   │  └──────┘                                     │
//   └──────────────────────────────────────────────┘
// On compact displays the filmstrip is the horizontal `FilmstripView` below
// the image. Info holds the editable rating and flag controls.
//
// Prev/next: horizontal swipe (touch) and ←/→ (desktop) move through the
// current folder's assets, wrapping. Pure selection logic lives in
// `PreviewView+VM.swift` and is unit-tested.

import MapleCore
import SwiftUI

#if os(iOS)
  import UIKit
#endif

// MARK: - PreviewView

struct PreviewView: View {
  /// The asset currently shown. Drives the image, filmstrip highlight, and
  /// the Info session lookup.
  let asset: AssetRef
  /// Ordered assets in the current folder — the filmstrip contents and the
  /// prev/next navigation domain (spec §4 "wraps selection through
  /// `assetsInSelectedFolder()`").
  let assets: [AssetRef]
  /// Source the assets came from — forwarded to `ThumbnailProvider` /
  /// `FilmstripView` so the sourceless thumb path (cloud / PhotoKit /
  /// self-hosted) resolves. `nil` for filesystem assets.
  let source: (any ImageSource)?
  /// The per-asset session cache (owned by `AppShell`). Preview reads an
  /// already-primed session for Info; it does NOT create renders. A
  /// binding (not a value) so a lazily-created session is written back.
  @Binding var sessions: [AssetRef.ID: EditSession]

  /// Back — pop Preview (iPhone) / return to Browse (Mac/iPad).
  let onDismiss: () -> Void
  /// iPhone: a pull-down committed. Carries where the photo's pixels are
  /// on screen right now (window space) so the hero can shrink it from
  /// there into its tile. `nil` (default) means plain `onDismiss`.
  var onPullDownCommitted: ((CGRect?) -> Void)? = nil
  /// iPhone: whether the chrome may show yet. The hero keeps it `false`
  /// while the photo is growing out of its tile and flips it once the
  /// open lands, so the header / filmstrip / bar fade in late, after the
  /// photo — as in Photos — instead of arriving with it.
  var chromeRevealed: Bool = true
  /// Enter the editor for the current asset (the ONLY editor entry point).
  let onEdit: (AssetRef) -> Void
  /// Move Preview to a sibling asset (filmstrip tap, swipe, arrow key). The
  /// parent updates its selection + navigation state and re-renders Preview
  /// with the new `asset`.
  let onSelectAsset: (AssetRef) -> Void
  @Environment(\.horizontalSizeClass) private var hSizeClass

  /// Info bottom sheet presentation — compact ONLY. Deliberately always
  /// starts closed regardless of the persisted preference (spec #2405: a
  /// sheet covering the photo on every Preview open is the wrong default
  /// for the surface whose whole purpose is showing the photo).
  @State private var showInfo = false
  /// Info inspector column presentation — regular (tablet+) ONLY. Persists
  /// across Preview opens under `cm.preview.infoOpen`, defaulting to open,
  /// mirroring the editor's `DetailPanel` inspector.
  @AppStorage("cm.preview.infoOpen") private var infoPaneOpenPreference = true
  /// The session backing Info. Primed by a `.task` keyed on the pane's
  /// open state (which can default to open on a regular display) — never during
  /// `body`, so opening Preview to look at a photo costs nothing when the
  /// pane is closed.
  @State private var infoSession: EditSession?
  /// Finger travel of the pull-down (iPhone) — the still follows it.
  @State private var plainPullTranslation: CGSize = .zero
  @State private var isPlainPullDismissing = false
  private var isRegular: Bool { hSizeClass == .regular }

  /// The compact filmstrip occupies the bottom edge; actions live together
  /// in the floating image header on both displays.
  private var bottomChromeHeight: CGFloat {
    isRegular ? 0 : FilmstripView.height
  }

  private var orderedIDs: [AssetRef.ID] { assets.map(\.id) }

  /// Chrome (header and strips) visibility: fades out over the
  /// first stretch of a pull-down so the photo is alone on the backdrop.
  private var chromeOpacity: Double {
    chromeRevealed
      ? PreviewViewVM.plainPullChromeOpacity(translationY: plainPullTranslation.height) : 0
  }

  var body: some View {
    ZStack {
      MapleTokens.bg
        .opacity(PreviewViewVM.plainPullBackdropOpacity(translationY: plainPullTranslation.height))
        .ignoresSafeArea()

      // Body: fit-to-screen still. On regular (iPad/Mac) the SAME
      // vertical `FilmstripRail` the editor mounts on its leading
      // edge floats over the image here too (#3402) — one rail
      // component, one placement, so tapping Edit doesn't move the
      // strip and a sibling tap on either surface stays on that
      // surface. On compact (iPhone) the horizontal `FilmstripView`
      // occupies the bottom band.
      //
      // The strips are OVERLAYS on the still, not stacked siblings, and
      // the still is inset by the compact strip's fixed height —
      // the same layout, but the chrome can fade independently of the
      // still during a pull-down.
      //
      // The prev/next swipe is scoped to the IMAGE area only — NOT
      // the whole container — so it doesn't compete with either
      // strip's own `ScrollView` (a container-wide DragGesture
      // would swallow the strip's drags and make it un-scrollable).
      // Copilot review #1810. The rail is a ZStack sibling sized to
      // its own glass panel: the `.frame(maxWidth:maxHeight:)`
      // wrapper carries no background or content shape, so hits
      // outside the panel fall straight through to the image body's
      // swipe / pager.
      ZStack {
        imageBody
          .background(photoAreaReporter)
          .padding(.horizontal, isRegular ? 16 : 8)
          .scaleEffect(PreviewViewVM.plainPullScale(translationY: plainPullTranslation.height))
          .offset(plainPullTranslation)

        if isRegular {
          FilmstripRail(
            assets: assets,
            activeID: asset.id,
            source: source,
            identifierPrefix: "preview",
            onSelect: onSelectAsset
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
          .padding(.leading, 12)
          .opacity(chromeOpacity)
        }
      }
      .padding(.bottom, bottomChromeHeight)
    }
    .onChange(of: asset.id) { _, _ in
      // A committed pull is tied to the photo it started on.
      isPlainPullDismissing = false
    }
    .overlay(alignment: .bottom) {
      VStack(spacing: 0) {
        if !isRegular {
          FilmstripView(
            assets: assets,
            activeID: asset.id,
            source: source,
            onSelect: onSelectAsset
          )
        }

      }
      .opacity(chromeOpacity)
    }
    .overlay(alignment: .top) {
      FloatingImageHeader(
        displayName: asset.displayName,
        identifierPrefix: "preview",
        onBack: onDismiss
      ) {
        Button {
          onEdit(asset)
        } label: {
          Image(systemName: "pencil")
            .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(ProTokens.text)
        .accessibilityLabel("Edit photo")
        .accessibilityIdentifier("preview-edit")

        Button {
          isInfoPresented.wrappedValue.toggle()
        } label: {
          Image(systemName: "info.circle")
            .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(ProTokens.text)
        .accessibilityLabel("Photo information")
        .accessibilityAddTraits(isInfoPresented.wrappedValue ? .isSelected : [])
        .accessibilityIdentifier("preview-info")
      }
      .padding(.top, 8)
      .opacity(chromeOpacity)
    }
    // After the chrome overlays, so the reveal fades them.
    .animation(MapleTokens.Motion.chromeHide, value: chromeRevealed)
    // Keyboard prev/next (desktop). `.focusable()` makes the surface a key
    // target; the arrow handlers move selection through the folder. (The
    // touch prev/next swipe is attached to `imageBody` above, not here, so
    // it doesn't steal either filmstrip's scroll.)
    .focusable(isRegular)
    .onKeyPress(.leftArrow) {
      stepPrevious()
      return .handled
    }
    .onKeyPress(.rightArrow) {
      stepNext()
      return .handled
    }
    // Drop the primed Info session when the shown asset changes
    // (swipe / arrow / filmstrip) so a re-open primes against the new
    // asset rather than reusing the previous one's session.
    .onChange(of: asset.id) { _, _ in
      infoSession = nil
    }
    // Re-prime the Info session whenever the pane is open — on first
    // appearance (the pane defaults to open, so no tap ever fires) and
    // again whenever `asset.id` changes while the pane stays open. A
    // closed pane primes nothing: the task body bails via
    // `needsSessionPriming` before touching `sessions`. This keeps the
    // write out of `body` (the hazard the comments above call out) while
    // covering the case the old tap-only priming could not.
    .task(id: InfoPrimeTrigger(assetID: asset.id, isOpen: isInfoPresented.wrappedValue)) {
      guard
        PreviewViewVM.needsSessionPriming(
          isPaneOpen: isInfoPresented.wrappedValue,
          hasSession: infoSession != nil
        )
      else { return }
      infoSession = ensureInfoSession()
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("preview-view")
    // Info: inspector column (regular) / bottom sheet (compact), mirroring
    // how `AppShellMacLayout` / `DetailPanel` present the editor's own
    // Info inspector.
    .modifier(
      InfoPresentation(
        isPresented: isInfoPresented,
        isRegular: isRegular,
        session: infoSession
      )
    )
  }

  /// The single source of truth for "is the Info surface presented",
  /// routed to the size-class-appropriate backing store: the persisted
  /// `infoPaneOpenPreference` at regular (tablet+), the transient
  /// `showInfo` `@State` at compact (iPhone sheet — always starts closed,
  /// never persisted). The read side calls `PreviewViewVM.infoPaneShouldOpen`
  /// — the pure, unit-tested form of the regular-vs-compact routing
  /// decision — OR'd with `showInfo` (which `infoPaneShouldOpen` always
  /// reports closed for compact, since it never reads the persisted
  /// preference there) so a compact tap-to-open still works.
  private var isInfoPresented: Binding<Bool> {
    Binding(
      get: {
        PreviewViewVM.infoPaneShouldOpen(
          isRegular: isRegular,
          storedPreference: infoPaneOpenPreference
        ) || (!isRegular && showInfo)
      },
      set: { newValue in
        if isRegular {
          infoPaneOpenPreference = newValue
        } else {
          showInfo = newValue
        }
      }
    )
  }

  // MARK: - Image body

  /// The fit-to-screen still. Purely a `PreviewImage` (thumbnail-cache
  /// backed) — no canvas, no zoom, no session.
  @ViewBuilder
  private var imageBody: some View {
    if asset.isVideo {
      PreviewVideoView(asset: asset, source: source)
    } else {
      #if os(iOS)
        PreviewPager(
          asset: asset,
          assets: assets,
          source: source,
          provider: provider,
          onSelectAsset: onSelectAsset,
          onPlainPullChanged: updatePlainPull,
          onPlainPullEnded: finishPlainPull
        )
        .accessibilityIdentifier("preview-image")
      #else
        // PageTabViewStyle is an iOS/iPadOS interaction. macOS keeps the
        // lightweight current image and uses the existing left/right keys.
        PreviewImage(
          source: PreviewViewVM.thumbnailSource(for: asset, source: source),
          provider: provider
        )
        .accessibilityIdentifier("preview-image")
      #endif
    }
  }

  /// One provider for the whole Preview lifetime. Local-only is correct here:
  /// cloud/self-hosted assets thread their `source` through the
  /// `.local(AssetRef, source:)` case, which `ThumbnailLoader` dispatches on.
  /// (Cloud-timeline thumbs use a different provider wired with a
  /// `CloudThumbClient`; Preview is opened from the local/library flow.)
  @State private var provider = ThumbnailProvider.local()

  // MARK: - Session priming (pipeline-free)

  /// Return a session for Info, creating one only if the grid didn't
  /// already prime it. Called from the Info-pane `.task` above — NEVER from
  /// `body` — so the `sessions` write
  /// never happens during a view update. The `EditSession` is lightweight —
  /// it allocates a pipeline object but performs no decode or render
  /// (`ensureRenderStarted()` is never called here), so priming it for
  /// Info doesn't boot the pipeline Preview exists to avoid. Writes go
  /// back into `sessions` so the grid badges + a later editor open share
  /// the same instance.
  private func ensureInfoSession() -> EditSession {
    if let existing = sessions[asset.id] { return existing }
    // Only local/library Preview reaches here today; a session-local
    // EditSession persists flag/rating in-memory and (for filesystem
    // assets) to the .xmp sidecar via EditSession's own store wiring.
    let session = EditSession(asset: asset)
    sessions[asset.id] = session
    Task { await session.loadSidecar() }
    return session
  }

  // MARK: - Navigation

  private func stepNext() {
    guard let id = PreviewViewVM.nextID(after: asset.id, in: orderedIDs),
      let next = assets.first(where: { $0.id == id })
    else { return }
    onSelectAsset(next)
  }

  private func stepPrevious() {
    guard let id = PreviewViewVM.previousID(before: asset.id, in: orderedIDs),
      let prev = assets.first(where: { $0.id == id })
    else { return }
    onSelectAsset(prev)
  }

  /// Publishes where the photo is laid out (window space) so the iPhone
  /// hero can land its still exactly on Preview's own. Measured under the
  /// pull's scale/offset, so it is the rest position.
  @ViewBuilder private var photoAreaReporter: some View {
    #if os(iOS)
      GeometryReader { geometry in
        Color.clear.preference(key: PreviewPhotoAreaKey.self, value: geometry.frame(in: .global))
      }
    #else
      Color.clear
    #endif
  }

  // MARK: - Pull-down (iPhone)

  private func updatePlainPull(_ translation: CGSize) {
    guard !isPlainPullDismissing else { return }
    plainPullTranslation = translation
  }

  private func finishPlainPull(_ translation: CGSize, _ velocity: CGSize, _ photoRect: CGRect?) {
    guard !isPlainPullDismissing else { return }
    if PreviewViewVM.shouldCommitPlainPull(
      translationY: translation.height, velocityY: velocity.height)
    {
      isPlainPullDismissing = true
      if let onPullDownCommitted {
        // Hand the hero the photo where the finger left it: the pager
        // reports the still's rest rect (the UIKit view knows nothing
        // of the SwiftUI pull transform), so apply the pull's scale
        // and offset here. The still itself stays where it is; the
        // hero hides this whole view the moment the close begins.
        let pulled = photoRect.map { rest in
          PreviewViewVM.pulledRect(
            rest,
            scale: PreviewViewVM.plainPullScale(translationY: translation.height),
            offset: translation)
        }
        onPullDownCommitted(pulled)
      } else {
        onDismiss()
      }
    } else {
      withAnimation(.spring(response: 0.36, dampingFraction: 0.82)) {
        plainPullTranslation = .zero
      }
    }
  }

}

// The UIKit pager lives in PreviewPager.swift so this screen remains focused
// on composition, navigation, and presentation state.

// MARK: - InfoPrimeTrigger

/// `.task(id:)` key for the Info-pane priming task on `PreviewView`. SwiftUI
/// cancels + restarts a `.task(id:)` whenever this value changes, which is
/// exactly the two moments priming needs to (re-)run: the pane's open state
/// flipping, or the shown asset changing while the pane stays open.
private struct InfoPrimeTrigger: Equatable {
  let assetID: AssetRef.ID
  let isOpen: Bool
}

// `InfoPresentation` lives in PreviewView+Presentation.swift.
// (file-size budget, #3402).

// MARK: - Previews

#if DEBUG
  #Preview("PreviewView") {
    struct Wrapper: View {
      @State private var sessions: [AssetRef.ID: EditSession] = [:]
      private let assets = (0..<5).map { AssetRef.preview(displayName: "IMG_000\($0).dng") }
      var body: some View {
        PreviewView(
          asset: assets[1],
          assets: assets,
          source: nil,
          sessions: $sessions,
          onDismiss: {},
          onEdit: { _ in },
          onSelectAsset: { _ in }
        )
        .frame(width: 1000, height: 720)
      }
    }
    return Wrapper()
  }
#endif
