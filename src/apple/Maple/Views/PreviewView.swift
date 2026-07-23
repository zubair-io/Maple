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
//   • Flag + Info reuse the asset's already-primed `EditSession` (created
//     lazily by the grid's `ensureSession`; `EditSession.init` allocates a
//     pipeline object but does NOT decode or render — the heavy work is
//     `ensureRenderStarted()`, which only the editor calls). Preview never
//     calls it, so those affordances cost nothing.
//
// Layout (spec §4):
//   ┌──────────────────────────────────────────────┐
//   │  ‹  filename                      histogram?  │  ← header (§6 max-width)
//   │  ┌──────┐                                     │
//   │  │ film │            FIT IMAGE                │  ← body + left filmstrip (regular)
//   │  │ strip│                                     │
//   │  └──────┘                                     │
//   │            [ Flag ]  [ Edit ]  [ Info ]       │  ← bottom bar
//   └──────────────────────────────────────────────┘
// On compact (iPhone) the filmstrip moves to a horizontal strip above the bar.
//
// Prev/next: horizontal swipe (touch) and ←/→ (desktop) move through the
// current folder's assets, wrapping. Pure selection logic lives in
// `PreviewView+VM.swift` and is unit-tested.

import SwiftUI
import MapleCore
#if os(iOS)
import UIKit
#endif

// MARK: - PreviewView

struct PreviewView: View {
    /// The asset currently shown. Drives the image, filmstrip highlight, and
    /// the Flag/Info session lookup.
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
    /// already-primed session for Flag/Info; it does NOT create renders. A
    /// binding (not a value) so a lazily-created session is written back.
    @Binding var sessions: [AssetRef.ID: EditSession]

    /// Back — pop Preview (iPhone) / return to Browse (Mac/iPad).
    let onDismiss: () -> Void
    /// Enter the editor for the current asset (the ONLY editor entry point).
    let onEdit: (AssetRef) -> Void
    /// Move Preview to a sibling asset (filmstrip tap, swipe, arrow key). The
    /// parent updates its selection + navigation state and re-renders Preview
    /// with the new `asset`.
    let onSelectAsset: (AssetRef) -> Void

    @Environment(\.horizontalSizeClass) private var hSizeClass

    /// Flag popover (regular) / bottom sheet (compact) presentation.
    @State private var showFlags = false
    /// Info side panel (regular) / bottom sheet (compact) presentation.
    @State private var showInfo = false
    /// The session backing the Flag / Info surfaces. Primed on tap (never
    /// during `body`) so opening Preview to look at a photo costs nothing.
    @State private var flagInfoSession: EditSession?
    /// Positive vertical travel for the interactive pull-down dismissal.
    @State private var dismissTranslation: CGFloat = 0
    @State private var isDismissing = false
    private var isRegular: Bool { hSizeClass == .regular }

    private var orderedIDs: [AssetRef.ID] { assets.map(\.id) }

    var body: some View {
        ZStack {
            MapleTokens.bg
                .opacity(dismissBackgroundOpacity)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                // Body: fit-to-screen still. `FilmstripView` is the shared
                // HORIZONTAL strip (spec §4 mandates reusing it), so it sits as
                // a band above the action bar on every size class rather than
                // as a left rail — a horizontal strip in a left column would
                // need a separate vertical component. (Divergence from the
                // "left filmstrip" wording noted in the design doc.)
                //
                // The prev/next swipe is scoped to the IMAGE area only — NOT the
                // whole container — so it doesn't compete with `FilmstripView`'s
                // own horizontal `ScrollView` (a container-wide DragGesture would
                // swallow the filmstrip's horizontal drags and make it
                // un-scrollable). Copilot review #1810.
                imageBody
                    .padding(.horizontal, isRegular ? 16 : 8)
                    .offset(y: dismissTranslation)
                    .scaleEffect(dismissScale)

                FilmstripView(
                    assets: assets,
                    activeID: asset.id,
                    source: source,
                    onSelect: onSelectAsset
                )

                PreviewActionBar(
                    // Prime the (pipeline-free) session ON TAP — never during
                    // body — then present. This keeps Preview open cheap: no
                    // session is created just to look at a photo, only when the
                    // user actually reaches for Flag / Info.
                    onFlag: { flagInfoSession = ensureFlagSession(); showFlags = true },
                    onEdit: { onEdit(asset) },
                    onInfo: { flagInfoSession = ensureFlagSession(); showInfo = true }
                )
            }
        }
        .overlay(alignment: .top) {
            FloatingImageHeader(
                displayName: asset.displayName,
                identifierPrefix: "preview",
                onBack: onDismiss
            ) { EmptyView() }
            .padding(.top, 8)
        }
        // Keyboard prev/next (desktop). `.focusable()` makes the surface a key
        // target; the arrow handlers move selection through the folder. (The
        // touch prev/next swipe is attached to `imageBody` above, not here, so
        // it doesn't steal the filmstrip's horizontal scroll.)
        .focusable(isRegular)
        .onKeyPress(.leftArrow) { stepPrevious(); return .handled }
        .onKeyPress(.rightArrow) { stepNext(); return .handled }
        // Drop the primed Flag/Info session when the shown asset changes
        // (swipe / arrow / filmstrip) so a re-open primes against the new
        // asset rather than reusing the previous one's session.
        .onChange(of: asset.id) { _, _ in
            flagInfoSession = nil
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("preview-view")
        // Flag: popover (regular) / bottom sheet (compact). Both reuse the
        // shared `RatingFlagsRow` against the primed session.
        .modifier(
            FlagPresentation(
                isPresented: $showFlags,
                isRegular: isRegular,
                session: flagInfoSession
            )
        )
        // Info: side panel (regular) / bottom sheet (compact), mirroring how
        // `EditorDestination` / `DetailPanel` present it elsewhere.
        .modifier(
            InfoPresentation(
                isPresented: $showInfo,
                isRegular: isRegular,
                session: flagInfoSession
            )
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
            onDismissDragChanged: updateDismissDrag,
            onDismissDragEnded: finishDismissDrag
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

    /// Return a session for Flag/Info, creating one only if the grid didn't
    /// already prime it. Called from a button-tap handler (NOT `body`), so the
    /// `sessions` write never happens during a view update. The `EditSession`
    /// is lightweight — it allocates a pipeline object but performs no decode
    /// or render (`ensureRenderStarted()` is never called here), so priming it
    /// for Flag/Info doesn't boot the pipeline Preview exists to avoid. Writes
    /// go back into `sessions` so the grid badges + a later editor open share
    /// the same instance.
    private func ensureFlagSession() -> EditSession {
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

    // MARK: - Pull-down dismissal

    private var dismissScale: CGFloat {
        max(0.88, 1 - dismissTranslation / 1_200)
    }

    private var dismissBackgroundOpacity: Double {
        max(0.35, 1 - Double(dismissTranslation / 500))
    }

    private func updateDismissDrag(_ translation: CGSize) {
        guard !isDismissing,
              translation.height > 0,
              translation.height > abs(translation.width) else { return }
        dismissTranslation = translation.height
    }

    private func finishDismissDrag(_ translation: CGSize, _ velocity: CGSize) {
        guard !isDismissing else {
            dismissTranslation = 0
            return
        }
        let wasVertical = translation.height > 0
            && translation.height > abs(translation.width)
        let shouldDismiss = wasVertical
            && (translation.height > 120 || velocity.height > 700)

        if shouldDismiss {
            isDismissing = true
            onDismiss()
        } else {
            withAnimation(.spring(response: 0.32, dampingFraction: 0.82)) {
                dismissTranslation = 0
            }
        }
    }

}

// The UIKit pager lives in PreviewPager.swift so this screen remains focused
// on composition, navigation, and presentation state.

// MARK: - PreviewImage

/// Fit-to-screen still image, backed by the shared thumbnail cache. Loads JPEG
/// bytes via `ThumbnailProvider` (the SAME path grid cells + the filmstrip use)
/// on appear and reloads when the source id changes (prev/next). No canvas, no
/// zoom, no session — this is the whole speed point.
///
/// `.task(id:)` owns the lifecycle: it auto-cancels the in-flight load when the
/// id changes or the view disappears (per `docs/best-practices.md` § Swift). A
/// swipe can still fire a new load before the previous resolves, so the result
/// is stale-guarded on `sourceID` before it paints — a superseded load never
/// overwrites the newer image.
private struct PreviewImage: View {
    let source: ThumbnailSource
    let provider: ThumbnailProvider
    var onZoomStateChanged: (Bool, Bool) -> Void = { _, _ in }

    /// Display-ready pixels. JPEG decoding must never happen in `body`: when a
    /// PhotoKit request completes during an interactive page transition, doing
    /// ImageIO decode there blocks the main thread and visibly stalls the pager.
    @State private var decodedImage: CGImage?
    @State private var loadedID: String?
    @State private var zoomScale: CGFloat = 1
    @GestureState private var pinchScale: CGFloat = 1

    /// Stable identity for the current source — drives `.task(id:)` reload and
    /// the stale-guard. `ThumbnailSource` isn't Hashable (it carries an
    /// existential source), so key on the asset id we can reach.
    private var sourceID: String {
        if case let .local(ref, _) = source {
            return ref.primaryURL?.absoluteString ?? ref.stableID ?? ref.displayName
        }
        return "\(source)"
    }

    var body: some View {
        ZStack {
            if let cg = decodedImage {
                Group {
                    #if os(macOS)
                    Image(nsImage: NSImage(cgImage: cg, size: .zero))
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                    #else
                    Image(uiImage: UIImage(cgImage: cg))
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                    #endif
                }
                .scaleEffect(effectiveZoom)
                .animation(.interactiveSpring(response: 0.25, dampingFraction: 0.86), value: zoomScale)
            } else {
                // No blank canvas — a neutral placeholder while the (already
                // cached, usually instant) thumbnail resolves.
                Image(systemName: "photo")
                    .font(.system(size: 56))
                    .foregroundStyle(ProTokens.textDim)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MapleTokens.bg)
        .clipped()
        .simultaneousGesture(pinchGesture)
        .task(id: sourceID) { await load(for: sourceID) }
        .onChange(of: sourceID) { _, _ in
            zoomScale = 1
            onZoomStateChanged(true, false)
        }
    }

    private func load(for id: String) async {
        // Already showing this source — nothing to do.
        if loadedID == id, decodedImage != nil { return }
        guard let data = await provider.thumbnail(for: source) else { return }
        let image = await Task.detached(priority: .userInitiated) {
            ThumbnailImage.cgImage(from: data)
        }.value
        // Stale-guard: a newer `.task(id:)` supersedes and cancels this one on
        // an id change, so `!Task.isCancelled` is the real check. (`sourceID`
        // is derived from the view's `source` prop; a re-created struct with a
        // new source runs its own fresh task, so a value compare here would be
        // redundant.) Copilot review #1810.
        guard !Task.isCancelled else { return }
        decodedImage = image
        loadedID = id

        // The tiny cached image owns first paint. Once it is on screen, ask
        // the source for display-sized pixels and swap them in only if this
        // page is still current.
        guard let previewData = await provider.preview(for: source) else { return }
        let enhanced = await Task.detached(priority: .utility) {
            ThumbnailImage.cgImage(from: previewData)
        }.value
        guard !Task.isCancelled, let enhanced else { return }
        decodedImage = enhanced
    }

    private var effectiveZoom: CGFloat {
        min(6, max(1, zoomScale * pinchScale))
    }

    private var pinchGesture: some Gesture {
        MagnifyGesture()
            .onChanged { _ in
                onZoomStateChanged(false, true)
            }
            .updating($pinchScale) { value, state, _ in
                state = value.magnification
            }
            .onEnded { value in
                zoomScale = min(6, max(1, zoomScale * value.magnification))
                onZoomStateChanged(zoomScale == 1, false)
            }
    }
}

// MARK: - PreviewActionBar

/// Bottom Flag · Edit · Info bar (spec §4). Edit is the emphasised primary
/// action (the only route into the editor); Flag + Info are secondary.
private struct PreviewActionBar: View {
    let onFlag: () -> Void
    let onEdit: () -> Void
    let onInfo: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            groupedButton(
                label: "Flag", systemImage: "flag",
                identifier: "preview-flag", action: onFlag
            )

            groupedButton(
                label: "Edit", systemImage: "slider.horizontal.3",
                identifier: "preview-edit", isPrimary: true, action: onEdit
            )

            groupedButton(
                label: "Info", systemImage: "info.circle",
                identifier: "preview-info", action: onInfo
            )
        }
        .padding(4)
        .modifier(PreviewActionGlass())
        .padding(.horizontal, 16)
        .frame(height: 56)
        .frame(maxWidth: .infinity)
        .background(ProTokens.bg)
        .accessibilityIdentifier("preview-action-bar")
    }

    private func groupedButton(
        label: String, systemImage: String, identifier: String,
        isPrimary: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(label, systemImage: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(isPrimary ? Color.white : MapleTokens.primary)
                .frame(minWidth: 96, minHeight: 44)
                .background(
                    isPrimary ? MapleTokens.primary : Color.clear,
                    in: Capsule()
                )
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }
}

private struct PreviewActionGlass: ViewModifier {
    func body(content: Content) -> some View {
        #if os(iOS)
        content.glassEffect(.regular.interactive(), in: .capsule)
        #else
        content.background(.ultraThinMaterial, in: Capsule())
        #endif
    }
}

// MARK: - Flag / Info presentation modifiers

/// Flag surface: popover on regular (desktop/iPad), bottom sheet on compact
/// (iPhone). Both host the shared `RatingFlagsRow`. Split into a modifier so
/// the platform branch stays out of `PreviewView.body`.
private struct FlagPresentation: ViewModifier {
    @Binding var isPresented: Bool
    let isRegular: Bool
    let session: EditSession?

    func body(content: Content) -> some View {
        if isRegular {
            content.popover(isPresented: $isPresented, arrowEdge: .bottom) {
                RatingFlagsRow(session: session)
                    .padding(16)
                    .frame(minWidth: 280)
                    .background(MapleTokens.surface)
            }
        } else {
            #if os(iOS)
            content.mapleBottomSheet(isPresented: $isPresented) {
                RatingFlagsRow(session: session)
                    .padding(20)
            }
            #else
            content.popover(isPresented: $isPresented, arrowEdge: .bottom) {
                RatingFlagsRow(session: session).padding(16).frame(minWidth: 280)
            }
            #endif
        }
    }
}

/// Info surface: side panel via `.inspector`-style popover on regular, bottom
/// sheet on compact — mirroring how `EditorDestination` / `DetailPanel` present
/// Info elsewhere. Reuses `InfoPanelView` (the S6 panel) directly.
private struct InfoPresentation: ViewModifier {
    @Binding var isPresented: Bool
    let isRegular: Bool
    let session: EditSession?

    func body(content: Content) -> some View {
        if isRegular {
            content.popover(isPresented: $isPresented, arrowEdge: .bottom) {
                InfoPanelView(
                    session: session,
                    isInsideSheet: true,
                    showsCullingAndHistogram: false,
                    onClose: { isPresented = false }
                )
                    .frame(width: 320, height: 480)
                    .background(MapleTokens.sidebar)
            }
        } else {
            #if os(iOS)
            content.sheet(isPresented: $isPresented) {
                InfoPanelView(
                    session: session,
                    isInsideSheet: false,
                    showsCullingAndHistogram: false
                )
                .presentationDetents([.medium, .large])
            }
            #else
            content.popover(isPresented: $isPresented, arrowEdge: .bottom) {
                InfoPanelView(session: session, isInsideSheet: false)
                    .frame(width: 320, height: 480)
            }
            #endif
        }
    }
}

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
