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
    /// Info bottom sheet presentation — compact ONLY. Deliberately always
    /// starts closed regardless of the persisted preference (spec #2405: a
    /// sheet covering the photo on every Preview open is the wrong default
    /// for the surface whose whole purpose is showing the photo).
    @State private var showInfo = false
    /// Info inspector column presentation — regular (tablet+) ONLY. Persists
    /// across Preview opens under `cm.preview.infoOpen`, defaulting to open,
    /// mirroring the editor's `DetailPanel` inspector.
    @AppStorage("cm.preview.infoOpen") private var infoPaneOpenPreference = true
    /// The session backing the Flag / Info surfaces. Primed on tap for Flag,
    /// and (since the Info pane can now be open by default with no tap at
    /// all) by a `.task` keyed on the pane's open state — never during
    /// `body`, so opening Preview to look at a photo costs nothing when the
    /// pane is closed.
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
                    // Flag still primes the (pipeline-free) session ON TAP —
                    // never during body — then presents. Info is now a
                    // toggle; its priming is handled by the `.task` below so
                    // a pane that's open by default (no tap at all) still
                    // primes correctly.
                    onFlag: { flagInfoSession = ensureFlagSession(); showFlags = true },
                    onEdit: { onEdit(asset) },
                    onInfo: { isInfoPresented.wrappedValue.toggle() },
                    isInfoOn: isInfoPresented.wrappedValue
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
        // Re-prime the Info session whenever the pane is open — on first
        // appearance (the pane defaults to open, so no tap ever fires) and
        // again whenever `asset.id` changes while the pane stays open. A
        // closed pane primes nothing: the task body bails via
        // `needsSessionPriming` before touching `sessions`. This keeps the
        // write out of `body` (the hazard the comments above call out) while
        // covering the case the old tap-only priming could not.
        .task(id: InfoPrimeTrigger(assetID: asset.id, isOpen: isInfoPresented.wrappedValue)) {
            guard PreviewViewVM.needsSessionPriming(
                isPaneOpen: isInfoPresented.wrappedValue,
                hasSession: flagInfoSession != nil
            ) else { return }
            flagInfoSession = ensureFlagSession()
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
        // Info: inspector column (regular) / bottom sheet (compact), mirroring
        // how `AppShellMacLayout` / `DetailPanel` present the editor's own
        // Info inspector.
        .modifier(
            InfoPresentation(
                isPresented: isInfoPresented,
                isRegular: isRegular,
                session: flagInfoSession
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
    /// already prime it. Called from a button-tap handler (Flag) or from the
    /// Info-pane `.task` above — NEVER from `body` — so the `sessions` write
    /// never happens during a view update. The `EditSession` is lightweight —
    /// it allocates a pipeline object but performs no decode or render
    /// (`ensureRenderStarted()` is never called here), so priming it for
    /// Flag/Info doesn't boot the pipeline Preview exists to avoid. Writes go
    /// back into `sessions` so the grid badges + a later editor open share
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

// MARK: - InfoPrimeTrigger

/// `.task(id:)` key for the Info-pane priming task on `PreviewView`. SwiftUI
/// cancels + restarts a `.task(id:)` whenever this value changes, which is
/// exactly the two moments priming needs to (re-)run: the pane's open state
/// flipping, or the shown asset changing while the pane stays open.
private struct InfoPrimeTrigger: Equatable {
    let assetID: AssetRef.ID
    let isOpen: Bool
}

// MARK: - PreviewActionBar

/// Bottom Flag · Edit · Info bar (spec §4). Edit is the emphasised primary
/// action (the only route into the editor); Flag + Info are secondary. Info
/// is a toggle — `isInfoOn` reflects the pane's live presented state as an
/// active tint, mirroring `aria-pressed` on Web.
private struct PreviewActionBar: View {
    let onFlag: () -> Void
    let onEdit: () -> Void
    let onInfo: () -> Void
    let isInfoOn: Bool

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
                identifier: "preview-info", isActive: isInfoOn, action: onInfo
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
        isActive: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(label, systemImage: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(isPrimary ? Color.white : MapleTokens.primary)
                .frame(minWidth: 96, minHeight: 44)
                .background(
                    isPrimary
                        ? MapleTokens.primary
                        : (isActive ? MapleTokens.primary.opacity(0.15) : Color.clear),
                    in: Capsule()
                )
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
        .accessibilityAddTraits(isActive ? .isSelected : [])
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

/// Info surface: a docked `.inspector` column on regular, bottom sheet on
/// compact — mirroring how `AppShellMacLayout` presents the editor's
/// `DetailPanel` (same modifier, same `.inspectorColumnWidth` clamps) so
/// Preview's pane and the editor's pane read as one thing. Reuses
/// `InfoPanelView` (the S6 panel) directly.
private struct InfoPresentation: ViewModifier {
    @Binding var isPresented: Bool
    let isRegular: Bool
    let session: EditSession?

    // Sheet / popover content does NOT inherit custom `EnvironmentKey`
    // values from the presenter the way an inline child does, so the
    // cloud clients injected at the AppShell root (#633 histogram, #2212
    // enrichment) arrive `nil` inside the presented `InfoPanelView` —
    // leaving the description / OCR / transcript section blank on iPhone
    // even for a Self-Hosted asset. Read them here (this modifier IS in
    // the AppShell environment) and re-inject them onto the presented
    // content below. An inspector's content is part of the view tree rather
    // than a separate presentation, so it would inherit these anyway — the
    // explicit re-injection just keeps the regular/compact branches from
    // diverging in a way a later reader has to re-derive.
    @Environment(\.cloudAssetDetailClient) private var detailClient
    @Environment(\.cloudHistogramClient) private var histogramClient
    // #2518 — same sheet non-inheritance applies to the reveal-folder action
    // that the info pane's clickable path row invokes; re-inject it too.
    @Environment(\.revealFolderAction) private var revealFolder

    func body(content: Content) -> some View {
        if isRegular {
            content
                .inspector(isPresented: $isPresented) {
                    InfoPanelView(
                        session: session,
                        isInsideSheet: false,
                        showsCullingAndHistogram: false
                    )
                    .environment(\.cloudAssetDetailClient, detailClient)
                    .environment(\.cloudHistogramClient, histogramClient)
                    .environment(\.revealFolderAction, revealFolder)
                    // Same clamps `AppShellMacLayout` applies to the
                    // editor's `DetailPanel` inspector.
                    .inspectorColumnWidth(min: 240, ideal: 280, max: 360)
                }
        } else {
            #if os(iOS)
            content.sheet(isPresented: $isPresented) {
                InfoPanelView(
                    session: session,
                    isInsideSheet: false,
                    showsCullingAndHistogram: false
                )
                .environment(\.cloudAssetDetailClient, detailClient)
                .environment(\.cloudHistogramClient, histogramClient)
                .environment(\.revealFolderAction, revealFolder)
                .presentationDetents([.medium, .large])
            }
            #else
            content.popover(isPresented: $isPresented, arrowEdge: .bottom) {
                InfoPanelView(session: session, isInsideSheet: false)
                    .frame(width: 320, height: 480)
                    .environment(\.cloudAssetDetailClient, detailClient)
                    .environment(\.cloudHistogramClient, histogramClient)
                    .environment(\.revealFolderAction, revealFolder)
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
