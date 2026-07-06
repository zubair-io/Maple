// PreviewView.swift — fast static-image Preview surface (Fast Preview epic,
// design doc 2026-07-06-fast-preview-and-phone-card-editor-design.md §1/§2/§4/§6).
//
// The lightweight surface inserted between the grid and the heavy editor. A
// grid tap lands HERE, not in the editor; the editor is reachable only via the
// Edit button. The whole point is speed:
//
//   • It creates NO render pipeline. It mounts no interactive GPU/CPU canvas
//     and no zoom controller. It paints a single cached JPEG through the SAME
//     `ThumbnailProvider` / `ThumbnailLoader` path the grid + filmstrip already
//     use — so opening a photo paints in ~1 frame and never blocks on the RAW
//     pipeline. (The dedicated 1280px "display preview" tier is spec §3 / slice
//     A1 and does not exist on Apple yet; until it lands there is one image
//     tier and no second swap.)
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

    private var isRegular: Bool { hSizeClass == .regular }

    /// The already-primed session for the current asset, if any. Preview never
    /// forces creation just to display an image — but Flag/Info need it, so the
    /// bar lazily primes one on demand (pipeline-free) via `ensureSession`.
    private var currentSession: EditSession? { sessions[asset.id] }

    private var orderedIDs: [AssetRef.ID] { assets.map(\.id) }

    var body: some View {
        ZStack {
            ProTokens.canvas.ignoresSafeArea()

            VStack(spacing: 0) {
                PreviewHeader(
                    displayName: asset.displayName,
                    onBack: onDismiss
                )

                // Body: fit-to-screen still. `FilmstripView` is the shared
                // HORIZONTAL strip (spec §4 mandates reusing it), so it sits as
                // a band above the action bar on every size class rather than
                // as a left rail — a horizontal strip in a left column would
                // need a separate vertical component. (Divergence from the
                // "left filmstrip" wording noted in the design doc.)
                imageBody
                    .padding(.horizontal, isRegular ? 16 : 8)

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
        // Keyboard prev/next (desktop). `.focusable()` makes the surface a key
        // target; the arrow handlers move selection through the folder.
        .focusable(isRegular)
        .onKeyPress(.leftArrow) { stepPrevious(); return .handled }
        .onKeyPress(.rightArrow) { stepNext(); return .handled }
        // Touch prev/next — a horizontal swipe past the threshold. The gesture
        // is on the whole surface (not just the image) so the whole viewport is
        // swipeable; the classification (threshold + horizontal dominance) is
        // in the VM.
        .gesture(swipeGesture)
        // Drop the primed Flag/Info session when the shown asset changes
        // (swipe / arrow / filmstrip) so a re-open primes against the new
        // asset rather than reusing the previous one's session.
        .onChange(of: asset.id) { _, _ in flagInfoSession = nil }
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
    private var imageBody: some View {
        PreviewImage(
            source: PreviewViewVM.thumbnailSource(for: asset, source: source),
            provider: provider
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("preview-image")
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

    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 20)
            .onEnded { value in
                switch PreviewViewVM.swipeStep(
                    dx: value.translation.width,
                    dy: value.translation.height
                ) {
                case .next: stepNext()
                case .previous: stepPrevious()
                case nil: break
                }
            }
    }
}

// MARK: - PreviewHeader

/// Preview's 44pt header — back · filename · (histogram placeholder). The
/// filename is capped at `PreviewViewVM.filenameMaxWidth` (200pt) with
/// middle-truncation, so a pathologically long name can never push the header
/// off-screen (spec §6) — the same cap `PillHeader` applies in the editor.
private struct PreviewHeader: View {
    let displayName: String
    let onBack: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ProTokens.text)
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")
            .accessibilityIdentifier("preview-back")

            Text(displayName)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(ProTokens.text)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: PreviewViewVM.filenameMaxWidth)
                .layoutPriority(1)
                .accessibilityIdentifier("preview-filename")

            Spacer(minLength: 0)

            // Histogram is spec §4 "optional" and needs render/luma data the
            // Preview surface deliberately never computes (that would boot the
            // pipeline it exists to avoid). Left out of v1 rather than faked;
            // if the display-preview data layer (§3 / A1) later exposes a cheap
            // histogram off the cached JPEG, it slots in here.
        }
        .padding(.horizontal, 16)
        .frame(height: 44)
        .background(ProTokens.bg)
        .accessibilityIdentifier("preview-header")
    }
}

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

    @State private var jpegData: Data?
    @State private var loadedID: String?

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
            if let data = jpegData, let cg = ThumbnailImage.cgImage(from: data) {
                #if os(macOS)
                Image(nsImage: NSImage(cgImage: cg, size: .zero))
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .transition(.opacity)
                #else
                Image(uiImage: UIImage(cgImage: cg))
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .transition(.opacity)
                #endif
            } else {
                // No blank canvas — a neutral placeholder while the (already
                // cached, usually instant) thumbnail resolves.
                Image(systemName: "photo")
                    .font(.system(size: 56))
                    .foregroundStyle(ProTokens.textDim)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: sourceID) { await load(for: sourceID) }
    }

    private func load(for id: String) async {
        // Already showing this source — nothing to do.
        if loadedID == id, jpegData != nil { return }
        let data = await provider.thumbnail(for: source)
        // Stale-guard: a newer `.task(id:)` may have superseded us mid-flight.
        guard !Task.isCancelled, sourceID == id else { return }
        withAnimation(.easeInOut(duration: 0.18)) {
            jpegData = data
            loadedID = id
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
        HStack(spacing: 24) {
            barButton(
                label: "Flag", systemImage: "flag",
                identifier: "preview-flag", action: onFlag)

            Button(action: onEdit) {
                HStack(spacing: 6) {
                    Image(systemName: "slider.horizontal.3")
                    Text("Edit").font(.system(size: 13, weight: .semibold))
                }
                .foregroundStyle(ProTokens.text)
                .padding(.horizontal, 20)
                .frame(height: 36)
                .background(ProTokens.accent, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Edit")
            .accessibilityIdentifier("preview-edit")

            barButton(
                label: "Info", systemImage: "info.circle",
                identifier: "preview-info", action: onInfo)
        }
        .padding(.horizontal, 16)
        .frame(height: 56)
        .frame(maxWidth: .infinity)
        .background(ProTokens.bg)
        .accessibilityIdentifier("preview-action-bar")
    }

    private func barButton(
        label: String, systemImage: String, identifier: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: systemImage).font(.system(size: 16))
                Text(label).font(.system(size: 10))
            }
            .foregroundStyle(ProTokens.textMuted)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
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
                InfoPanelView(session: session, isInsideSheet: false)
                    .frame(width: 320, height: 480)
                    .background(MapleTokens.sidebar)
            }
        } else {
            #if os(iOS)
            content.sheet(isPresented: $isPresented) {
                NavigationStack {
                    InfoPanelView(session: session, isInsideSheet: true)
                        .navigationTitle("Info")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Done") { isPresented = false }
                            }
                        }
                }
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
