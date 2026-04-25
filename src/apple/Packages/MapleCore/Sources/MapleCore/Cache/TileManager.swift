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
//   docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md Task 6.

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
    /// landed at v2.
    public static let viewTransformVersion: UInt32 = 2

    private struct Entry {
        let image: CIImage
    }

    private var entries: [TileKey: Entry] = [:]
    private var inFlight: [TileKey: Task<CIImage, Error>] = [:]
    private let rawCache: RawImageCache

    /// Construct with the shared `RawImageCache` (Task 5). Tile renders
    /// resolve their handle through the cache so the rawler decode runs
    /// once per asset — see Plan 3 Task 5.
    public init(rawCache: RawImageCache) {
        self.rawCache = rawCache
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
    /// Throws are reserved for future use (e.g. surfacing pipeline
    /// errors); the current implementation never throws and just
    /// returns whatever's in cache.
    public func update(
        asset: AssetRef,
        viewportSourceRect: CGRect,
        zoom: CGFloat
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

        var composite = CIImage.empty()
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
                let placed = entry.image.transformed(by: CGAffineTransform(
                    translationX: CGFloat(key.tileX) * CGFloat(Self.tileSizeSourcePx),
                    y: CGFloat(key.tileY) * CGFloat(Self.tileSizeSourcePx)
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
        return composite
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
    }

    /// Insert a synthetic tile under `key`. Bypasses the fetch path —
    /// for tests that want to populate the cache directly.
    public func testInsertTile(key: TileKey, image: CIImage) {
        entries[key] = Entry(image: image)
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

    /// Background-task completion handler. Stores the rendered tile
    /// and clears the in-flight slot.
    private func completeFetch(key: TileKey, image: CIImage) {
        entries[key] = Entry(image: image)
        inFlight.removeValue(forKey: key)
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
