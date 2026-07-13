// TileManager.swift — In-memory tile cache + composite engine for
// Plan 3 (Ticket 06 M4) deep-zoom rendering.
//
// Public API:
//   actor TileManager
//     init(rawCache: RawImageCache)
//     update(asset:viewportSourceRect:zoom:) async throws -> CIImage
//     invalidate(asset:) async
//     clear() async
//
// Cache key: (asset URL hash, sidecar mtime, view-transform version,
// zoom bucket, tile X, tile Y).
//
// First-plan scope (per the executing brief):
//   * Simple dictionary cache. No LRU. No byte budget. No prefetch.
//   * One in-flight `Task` per missing tile so a flurry of `update`
//     calls during a pan doesn't double-schedule the same tile.
//   * Caller is responsible for showing the upscaled cached preview
//     underneath while tiles render — `update` only returns the
//     composite of currently-cached visible tiles. The caller paints
//     it on top of its own underlay.
//
// Tile geometry: 512² in oriented full-image SOURCE pixels. The plan
// caps zoom buckets at 8× — past that we keep returning 8× tiles and
// let the caller upscale.
//
// Cross-link:
//   .archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md Task 6.

import Foundation
import CoreImage
import CryptoKit

/// Composite key for a single tile entry. The fields are spelled out so
/// `Hashable` synthesis covers the whole identity (asset, sidecar
/// freshness, view-transform version, zoom bucket, tile coords).
public struct TileKey: Hashable, Sendable {
    /// 32-character lowercase MD5 hex of the asset URL path. Cheap to
    /// compute, fixed-width (so logs / dumps line up), and stable
    /// across Task hops.
    public let urlHash: String
    /// XMP sidecar mtime — bumps on every adjustment edit.
    public let sidecarMtime: Date
    /// View-transform pipeline version — bumps when the scene-linear
    /// chain or the view transform changes (Plan 2 lifted this to v2).
    /// Old tiles become uncacheable on a version bump.
    public let viewTransformVersion: UInt32
    /// Conservative zoom bucket: 1, 2, 4, 8. Past 8× the bucket clamps.
    public let zoomBucket: UInt32
    /// Tile column in 512-pixel grid coords (oriented source space).
    public let tileX: UInt32
    /// Tile row in 512-pixel grid coords.
    public let tileY: UInt32

    public init(
        urlHash: String,
        sidecarMtime: Date,
        viewTransformVersion: UInt32,
        zoomBucket: UInt32,
        tileX: UInt32,
        tileY: UInt32
    ) {
        self.urlHash = urlHash
        self.sidecarMtime = sidecarMtime
        self.viewTransformVersion = viewTransformVersion
        self.zoomBucket = zoomBucket
        self.tileX = tileX
        self.tileY = tileY
    }
}

public actor TileManager {
    /// Tile geometry constant — 512 source pixels per side. Locked by
    /// the brief.
    public static let tileSizeSourcePx: UInt32 = 512

    /// Current view-transform pipeline version. Bump when the
    /// scene-linear chain or the view transform changes meaning. Plan 2
    /// landed at v2. v3 (#263): canonical Sobotka AgX with inset/outset
    /// matrices + real Jed Smith sigmoid (mid-gray 0.237 → 0.18).
    /// v4 (2026-07-12, #1904): the #1893/#1894 WB value-mapping series —
    /// Robertson slider mapping, the Robertson-consistent frame/profile
    /// CCT solve, and single-CM embedded-frame anchoring change the
    /// scene-linear chain's WB meaning; paired with RenderedPreviewCache
    /// viewTransformVersion=7 / DecodedBufferCache rustVersion=6.
    /// v5 (2026-07-12, #1976): the per-tick WB delta anchor moved from the
    /// false explicit-(6500, 0) "decode bake" to the buffer's actual
    /// as-shot bake — native-detail tiles rendered under the old anchor
    /// carry the cyan overcool; paired with RenderedPreviewCache
    /// viewTransformVersion=8.
    public static let viewTransformVersion: UInt32 = 5

    private struct Entry {
        let image: CIImage
    }

    private var entries: [TileKey: Entry] = [:]
    private var inFlight: [TileKey: Task<CIImage, Error>] = [:]
    private let rawCache: RawImageCache

    // Tile-completion notification (Task 8 / Plan 3).
    //
    // EditSession's deep-zoom path returns a `CIImage` from `update(...)`
    // immediately, even when no tiles are cached yet — it relies on the
    // upscaled preview underlay to fill the gap. As tiles render in the
    // background, EditSession needs to know so it can re-call `update`
    // and re-publish the composite. We surface that as an
    // `AsyncStream<TileKey>` callers subscribe to via `events()`. The
    // stream yields ONE element per tile insert (cache hit or
    // synchronous test insert), is multicast (every active subscriber
    // sees every event), and stays alive for the lifetime of the
    // `TileManager`. Subscribers terminate their loop by cancelling
    // their task; the stream itself never finishes during the actor's
    // lifetime.
    //
    // Implementation: a list of continuations is held inside the actor.
    // `events()` constructs a fresh `AsyncStream`, registers its
    // continuation under a unique id, and arranges to drop the
    // continuation on stream termination so a subscriber that walks
    // away doesn't leak.
    private var nextSubscriberID: UInt64 = 0
    private var subscribers: [UInt64: AsyncStream<TileKey>.Continuation] = [:]

    /// Construct with the shared `RawImageCache` (Task 5). Tile renders
    /// resolve their handle through the cache so the rawler decode runs
    /// once per asset — see Plan 3 Task 5.
    public init(rawCache: RawImageCache) {
        self.rawCache = rawCache
    }

    deinit {
        // Defensive: terminate every outstanding subscriber so any task
        // awaiting `for await _ in stream` exits cleanly. Actor-isolated
        // properties can be touched from `deinit` since Swift 5.10.
        for (_, cont) in subscribers { cont.finish() }
        subscribers.removeAll()
    }

    // MARK: - Public API

    /// Returns a `CIImage` composited from currently-cached tiles
    /// inside `viewportSourceRect`. Tiles missing from the cache are
    /// enqueued for a background render; this call does NOT wait for
    /// them. The caller is expected to show its own upscaled preview
    /// underneath the returned image, then re-call `update` when a new
    /// tile lands (which it can detect by polling `testCachedTileCount`
    /// in tests, or by listening to a future "tile-ready" hook —
    /// out of scope for this first plan).
    ///
    /// `viewportSourceRect` is in oriented full-image source pixel
    /// coordinates. `zoom` is the user's logical zoom factor (1× = fit,
    /// 4× = 4 source pixels per screen pixel) and gets quantized to a
    /// zoom bucket via `zoomBucket(for:)`.
    ///
    /// `totalSourceSize` is the oriented full-image size in source
    /// pixels (i.e. `EditSession.nativeImageSize`). It anchors the
    /// Y-flip that reconciles tile-grid Y-down (rows top-to-bottom)
    /// with CoreImage's Y-up rasterization, AND it sets the returned
    /// composite's extent so the consuming `CIImageView` (which builds
    /// a CGImage from `image.extent`) sees the full canvas, not just
    /// the visible tile bounding box. Without that, SwiftUI's
    /// `aspectRatio(.fit)` shrinks the partial composite into a small
    /// letterboxed render.
    ///
    /// Throws are reserved for future use (e.g. surfacing pipeline
    /// errors); the current implementation never throws and just
    /// returns whatever's in cache.
    public func update(
        asset: AssetRef,
        viewportSourceRect: CGRect,
        zoom: CGFloat,
        totalSourceSize: CGSize
    ) async throws -> CIImage {
        guard let url = asset.primaryURL else {
            // Sourceless assets (PhotoKit / SelfHosted) don't have a
            // stable URL hash for the tile cache yet; future work.
            return CIImage.empty()
        }
        let urlHash = Self.urlHash(url)
        let sidecarMtime = Self.sidecarMtime(for: asset)
        let bucket = Self.zoomBucket(for: zoom)
        let positions = Self.tileSet(forVisibleSourceRect: viewportSourceRect, zoom: zoom)

        // Anchor the composite to the FULL image canvas. CIImage.empty()
        // has empty extent (origin ∞, size 0); cropping it to the canvas
        // rect still yields an empty-extent image, so compositing tiles
        // over it leaves `composite.extent` = the bounding box of placed
        // tiles only (e.g. a 4×6-tile strip at origin (2560, 1316) for a
        // mid-canvas viewport). The consuming `CIImageView` then builds a
        // CGImage of THOSE dims and SwiftUI's `aspectRatio(.fit)`
        // stretches the strip into the landscape frame — looks like a
        // ~2× zoom but is actually a wrong-aspect-ratio fit. User
        // reported this exactly at extent=2048x3072 origin=(2560,1316)
        // on a 7216x5412 canvas.
        //
        // Use `CIImage(color: .clear)` instead — infinite-extent solid
        // clear — and crop it to the canvas. The crop produces a finite
        // canvas-extent transparent image. After tile compositing, force
        // a final `cropped(to: canvasRect)` as belt-and-suspenders so the
        // returned extent always equals the canvas regardless of CoreImage
        // optimizer behavior.
        let canvasRect = CGRect(origin: .zero, size: totalSourceSize)
        let canvas = CIImage(color: CIColor.clear).cropped(to: canvasRect)
        var composite = canvas
        for pos in positions {
            let key = TileKey(
                urlHash: urlHash,
                sidecarMtime: sidecarMtime,
                viewTransformVersion: Self.viewTransformVersion,
                zoomBucket: bucket,
                tileX: pos.tileX,
                tileY: pos.tileY
            )
            if let entry = entries[key] {
                // Hit — translate the tile into its viewport position
                // and composite over what we already have. Each tile
                // is rendered at 512 source-pixel scale (the FFI's
                // `outW/outH` is locked at 512 in the basic path).
                //
                // Y-flip: tile-grid rows are top-down (tileY=0 is the
                // top tile in oriented source space) but CoreImage Y is
                // up. Place each tile at `totalSourceSize.height -
                // (tileY+1) * tileSize` so source-row 0 lands at the top
                // of the rasterized output. Without this flip, the
                // composite renders upside-down — every tile correct in
                // isolation, but the GRID flips top-to-bottom.
                let ts = CGFloat(Self.tileSizeSourcePx)
                let placed = entry.image.transformed(by: CGAffineTransform(
                    translationX: CGFloat(key.tileX) * ts,
                    y: totalSourceSize.height - CGFloat(Int(key.tileY) + 1) * ts
                ))
                composite = placed.composited(over: composite)
                continue
            }
            // Miss — enqueue if not already in flight. Fire-and-forget;
            // the caller will see the new tile next time `update` runs.
            if inFlight[key] == nil {
                let task = scheduleFetch(key: key, asset: asset)
                inFlight[key] = task
            }
        }
        // Belt-and-suspenders: force the returned extent to equal the
        // canvas. CoreImage's compositor may simplify away the clear
        // anchor in some configurations, so a final crop guarantees
        // consumers see `extent == canvasRect`.
        return composite.cropped(to: canvasRect)
    }

    /// Drop every tile whose `urlHash` matches the asset's URL. Tiles
    /// for other assets stay put. Cancels any in-flight fetches for
    /// the asset too.
    public func invalidate(asset: AssetRef) {
        guard let url = asset.primaryURL else { return }
        let hash = Self.urlHash(url)
        entries = entries.filter { $0.key.urlHash != hash }
        for (key, task) in inFlight where key.urlHash == hash {
            task.cancel()
            inFlight.removeValue(forKey: key)
        }
    }

    /// Reset the entire cache. Cancels every in-flight fetch.
    public func clear() {
        entries.removeAll()
        for (_, task) in inFlight { task.cancel() }
        inFlight.removeAll()
    }

    /// Subscribe to tile-completion events. The returned stream yields a
    /// `TileKey` every time a new tile is inserted into the cache — by
    /// the background fetch path or by the synchronous test entries.
    /// Multiple subscribers are supported; each gets every event. The
    /// stream stays alive for the lifetime of this `TileManager`; cancel
    /// the awaiting task to disconnect.
    public func events() -> AsyncStream<TileKey> {
        let id = nextSubscriberID
        nextSubscriberID &+= 1
        return AsyncStream<TileKey> { continuation in
            // Register synchronously inside the build closure — the
            // closure runs on the actor's executor because `events()`
            // is actor-isolated, so a direct dictionary write is safe.
            self.subscribers[id] = continuation
            continuation.onTermination = { [weak self] _ in
                // Termination can fire from any task; hop back to the
                // actor to mutate the dictionary.
                Task { [weak self] in
                    await self?.removeSubscriber(id: id)
                }
            }
        }
    }

    /// Drop a subscriber by id. Called from each subscription's
    /// termination handler.
    private func removeSubscriber(id: UInt64) {
        subscribers.removeValue(forKey: id)
    }

    /// Yield a `TileKey` to every active subscriber. Called whenever a
    /// tile lands in `entries`.
    private func notifyTileInserted(_ key: TileKey) {
        for (_, cont) in subscribers { cont.yield(key) }
    }

    // MARK: - Geometry helpers (pure, nonisolated for testability)

    /// Compute the set of 512-pixel grid coordinates that cover
    /// `rect`. The rectangle is in oriented full-image source pixels;
    /// the function rounds OUTWARD (`floor` on the min, `ceil` on the
    /// max) so partially-visible tiles are included.
    ///
    /// `zoom` is accepted for future use (per-bucket geometry, e.g.
    /// supersampled tile sizes at 4×) but the first-plan
    /// implementation ignores it — geometry is constant in source
    /// pixel space.
    nonisolated public static func tileSet(
        forVisibleSourceRect rect: CGRect,
        zoom: CGFloat,
        tileSize: UInt32 = TileManager.tileSizeSourcePx
    ) -> [(tileX: UInt32, tileY: UInt32)] {
        _ = zoom
        guard rect.width > 0, rect.height > 0 else { return [] }
        let ts = CGFloat(tileSize)
        let x0 = max(0, Int(floor(rect.minX / ts)))
        let y0 = max(0, Int(floor(rect.minY / ts)))
        // ceil-1 because we want the LAST tile that the rect touches,
        // not the first tile that lies past it.
        let x1 = max(x0, Int(ceil(rect.maxX / ts)) - 1)
        let y1 = max(y0, Int(ceil(rect.maxY / ts)) - 1)
        var out: [(tileX: UInt32, tileY: UInt32)] = []
        out.reserveCapacity((x1 - x0 + 1) * (y1 - y0 + 1))
        for ty in y0...y1 {
            for tx in x0...x1 {
                out.append((tileX: UInt32(tx), tileY: UInt32(ty)))
            }
        }
        return out
    }

    /// Quantize a CGFloat zoom level to one of the brief's zoom
    /// buckets {1, 2, 4, 8}. Above 8× clamps to 8.
    nonisolated public static func zoomBucket(for zoom: CGFloat) -> UInt32 {
        if zoom < 2.0 { return 1 }
        if zoom < 4.0 { return 2 }
        if zoom < 8.0 { return 4 }
        return 8
    }

    /// 32-char lowercase MD5 hex of a URL's path. Used inside `TileKey`
    /// so cache lookups are stable across actor hops without leaking
    /// the full path to logs.
    nonisolated public static func urlHash(_ url: URL) -> String {
        let digest = Insecure.MD5.hash(data: Data(url.path.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Test-only entry points

    /// Synchronously fetch + insert a tile under `key`. Used by tests
    /// to drive the miss → render → hit flow without racing against
    /// the fire-and-forget Task. Throws whatever the underlying FFI
    /// throws.
    public func testFetchTileSync(key: TileKey, asset: AssetRef) async throws {
        let image = try await fetch(key: key, asset: asset)
        entries[key] = Entry(image: image)
        notifyTileInserted(key)
    }

    /// Insert a synthetic tile under `key`. Bypasses the fetch path —
    /// for tests that want to populate the cache directly.
    public func testInsertTile(key: TileKey, image: CIImage) {
        entries[key] = Entry(image: image)
        notifyTileInserted(key)
    }

    /// Number of tiles currently cached.
    public func testCachedTileCount() -> Int { entries.count }

    /// Number of in-flight fetches. For diagnostic tests.
    public func testInFlightCount() -> Int { inFlight.count }

    // MARK: - Private fetch path

    /// Schedule a background fetch for a missing tile. Resolves the
    /// handle through `RawImageCache`, runs `PipelineRenderer.renderTile`,
    /// stores the result, and clears the in-flight slot.
    private func scheduleFetch(key: TileKey, asset: AssetRef) -> Task<CIImage, Error> {
        let task = Task<CIImage, Error> { [weak self] in
            guard let self else {
                throw CancellationError()
            }
            let image = try await self.fetch(key: key, asset: asset)
            await self.completeFetch(key: key, image: image)
            return image
        }
        return task
    }

    /// Common fetch path used by both the background `Task` and the
    /// test-synchronous entry. Resolves the handle, runs the tile FFI,
    /// returns the resulting CIImage.
    private func fetch(key: TileKey, asset: AssetRef) async throws -> CIImage {
        guard let url = asset.primaryURL else {
            throw CancellationError()  // sourceless not yet supported
        }
        let handle = try await rawCache.handle(for: url)
        let tilePx = Self.tileSizeSourcePx
        let imageData = try PipelineRenderer.renderTile(
            handle: handle,
            srcX: key.tileX * tilePx,
            srcY: key.tileY * tilePx,
            srcW: tilePx,
            srcH: tilePx,
            outW: tilePx,
            outH: tilePx,
            quality: .full
        )
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return CIImage(
            bitmapData: imageData.pixels,
            bytesPerRow: imageData.width * imageData.bytesPerPixel,
            size: CGSize(width: imageData.width, height: imageData.height),
            format: .RGBAh,
            colorSpace: space
        )
    }

    /// Background-task completion handler. Stores the rendered tile,
    /// clears the in-flight slot, and notifies subscribers so the
    /// editor can re-composite.
    private func completeFetch(key: TileKey, image: CIImage) {
        entries[key] = Entry(image: image)
        inFlight.removeValue(forKey: key)
        notifyTileInserted(key)
    }

    // MARK: - Sidecar mtime lookup

    /// Best-effort sidecar mtime — used as part of `TileKey` so a
    /// sidecar edit invalidates every tile for that asset. Falls back
    /// to `Date.distantPast` when the sidecar doesn't exist (an
    /// unedited asset; that's fine — the key is just stable).
    nonisolated private static func sidecarMtime(for asset: AssetRef) -> Date {
        guard let sidecarURL = asset.sidecarURL else { return .distantPast }
        let attrs = try? FileManager.default.attributesOfItem(atPath: sidecarURL.path)
        return (attrs?[.modificationDate] as? Date) ?? .distantPast
    }
}
