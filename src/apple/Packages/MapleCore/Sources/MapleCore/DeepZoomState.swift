// DeepZoomState.swift — owned storage for EditSession's deep-zoom /
// viewport plumbing (Plan 3 / Ticket 06 M4), split out of EditSession.swift
// itself (#2683 round-2 review item 3: EditSession.swift crossed the
// 570-line headroom gate — `tools/check-budget-headroom.sh`). Extensions
// can't hold stored properties, so this is a dedicated owned type (a plain
// `@MainActor` class, not `@Observable` — see `EditSession.deepZoomState`'s
// doc comment for why that's safe) rather than another `EditSession+*.swift`
// behavior file — `EditSession+DeepZoom.swift` is unchanged and still owns
// the BEHAVIOR that reads/writes these fields, via `EditSession`'s
// forwarding computed properties declared where these fields used to be
// stored directly.
//
// Pure state relocation — no behavior change. Every field here is
// byte-for-byte the same stored property `EditSession` declared before this
// split, with the same doc comments.

import Foundation
import CoreGraphics

@MainActor
final class DeepZoomState {
    /// Tile manager for deep-zoom (`pixelScale >= 1.0`) refine renders.
    /// Created lazily on the first deep-zoom request so that
    /// fit-mode-only sessions never allocate one. Shares the
    /// process-wide `RawImageCache.shared` so the rawler decode is
    /// reused across sessions and tile fetches.
    var tileManager: TileManager?

    /// Background task that listens to `tileManager.events()` and
    /// re-kicks `_scheduleRefine()` whenever a tile lands. Cancelled
    /// when the asset switches or the session deinits.
    var tileEventsTask: Task<Void, Never>?

    /// Observer that drives `downloadProgress` while iOS/macOS materializes
    /// a FileProvider-backed asset (Files-app sidebar / iCloud Drive).
    /// Created lazily by `openAssetPipelineAsync` for URL-backed assets;
    /// stays nil for cloud-search opens (those drive progress via
    /// `CloudByteDownloadBox`) and for sourceless assets without a URL.
    var fileProviderObserver: FileProviderDownloadObserver?

    /// Visible region in oriented full-image source-pixel coords. Set by
    /// `CanvasZoomController` via `updateTileVisibleRegion(viewport:zoom:)`.
    /// `_scheduleRefine`'s deep-zoom branch reads this when targeting
    /// the tile manager. `.zero` disables the deep-zoom branch.
    var viewportSourceRect: CGRect = .zero

    /// Viewport size in real pixels — set by `GpuLiveCanvasView` /
    /// `CanvasZoomController`. Used as the fast phase's target size so the
    /// filter chain runs at viewport resolution rather than native
    /// resolution. Plain storage here — `EditSession.previewSize`'s
    /// computed property carries the scheduling side effects a change
    /// triggers (a stored-property `didSet` before this split):
    ///
    ///   - `.zero` -> real size (first-time mount): the first render
    ///     (usually `ensureRenderStarted()` racing the canvas mount) used
    ///     the zero target and produced nothing visible, so the setter
    ///     re-kicks the fast phase to make the image appear immediately.
    ///   - real size -> a DIFFERENT real size (window resize): refine
    ///     only; `_scheduleRender` also cancels the prior refine, so a
    ///     continuous drag coalesces into one refine pass once the user
    ///     stops.
    ///   - Either transition also retries the cache-preview seed if it's
    ///     still waiting for a usable width (#2041) — deliberately OUTSIDE
    ///     the zero-transition branch: a sub-pixel layout-churn transient
    ///     (0 -> 0.5) takes the zero branch but fails the seed's
    ///     `width >= 1` guard and re-arms the pending flag, and the real
    ///     width then arrives with `oldValue == 0.5` — gating the retry on
    ///     `oldValue == .zero` would strand the flag forever (jules
    ///     review). `retryCachedPreviewSeedIfPending`'s own internal guard
    ///     makes this free on every non-pending update.
    var previewSize: CGSize = .zero
}
