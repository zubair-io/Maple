// NativeDetailRenderer.swift — viewport-bounded native-pixel RAW refinement.
//
// Zoom-to-fit stays on the sized whole-image decode. At 100% and above this
// actor opens one stripped-model RAW handle, develops only the visible source
// rectangle (plus a small filter halo), and returns scene-linear fp16 pixels
// for the normal Apple display chain. No full-sensor RGBAf buffer is created.

import CoreImage
import Foundation

/// Pure source-geometry helpers shared by the renderer, session, and tests.
enum NativeDetailLOD {
    static let minimumPixelScale: CGFloat = 1
    /// Covers dehaze's 67 px stencil plus headroom for chained filters.
    static let filterHalo: CGFloat = 96

    /// Ticket #2063 pan-reuse margin — independent of `filterHalo`.
    /// `filterHalo` is unpublished filter-stencil context added around the
    /// developed patch when `decodeRect` builds the decode-tile request;
    /// this margin instead grows the DEVELOPED AND PUBLISHED patch itself
    /// (`patchRect`, below) beyond the immediate viewport (`detailRect`), so
    /// a typical small pan's new viewport still lands inside the previous
    /// publish and hits the containment fast path in
    /// `EditSession.updateTileVisibleRegion` / `refineNativeDetail` instead
    /// of paying a fresh 150 ms-debounced develop.
    ///
    /// `panMargin(for:)` returns the TOTAL pixels added along each
    /// dimension (split evenly between both edges by `patchRect`) — 25% of
    /// the visible rect's larger dimension, clamped to `panMarginCeiling`,
    /// applied to BOTH width and height. For a SQUARE viewport, unclamped,
    /// that grows both dimensions by exactly `panMarginFraction` and raises
    /// the developed area by (1 + panMarginFraction)² ≈ 1.56×. A wider (or
    /// taller) viewport grows its shorter axis by a bigger relative
    /// fraction — the margin is sized from the LONGER dimension but
    /// applied evenly to both — so a typical widescreen viewport's
    /// multiplier lands a bit above that; the ceiling caps it back down
    /// once a dimension exceeds `panMarginCeiling / panMarginFraction`
    /// (2048 px at these defaults). See the PR description for the
    /// worked numbers on a representative viewport size.
    static let panMarginFraction: CGFloat = 0.25
    static let panMarginCeiling: CGFloat = 512

    static func shouldRender(pixelScale: CGFloat, visibleRect: CGRect) -> Bool {
        pixelScale >= minimumPixelScale
            && !visibleRect.isEmpty
            && !visibleRect.isNull
            && visibleRect.width > 0
            && visibleRect.height > 0
    }

    /// Integer source rect displayed by the overlay. Rounds outward so every
    /// visible source pixel is covered, then clamps to the oriented image.
    static func detailRect(visibleRect: CGRect, imageSize: CGSize) -> CGRect {
        let bounds = CGRect(origin: .zero, size: imageSize)
        guard bounds.width > 0, bounds.height > 0 else { return .zero }
        let rect = visibleRect.standardized.integral.intersection(bounds)
        return rect.isNull ? .zero : rect
    }

    /// Total pixels the pan-reuse patch grows by along each dimension
    /// (`patchRect` splits this evenly between both edges) — 25% of
    /// `visibleRect`'s larger dimension, clamped to `panMarginCeiling` so an
    /// unusually large viewport doesn't blow the develop out arbitrarily.
    /// Pure function of the rect's size alone so it's directly
    /// unit-testable without a full detail/image-bounds round trip.
    static func panMargin(for visibleRect: CGRect) -> CGFloat {
        guard !visibleRect.isEmpty, !visibleRect.isNull else { return 0 }
        let longest = max(visibleRect.width, visibleRect.height)
        return min(longest * panMarginFraction, panMarginCeiling)
    }

    /// The rect actually DEVELOPED and PUBLISHED as `nativeDetailPreview` /
    /// `nativeDetailSourceRect` (#2063) — `detailRect` grown by
    /// `panMargin(for:)`, split evenly across both edges, and re-clamped to
    /// the oriented image bounds. Deliberately larger than the immediate
    /// viewport so an ordinary small pan's new `detailRect` still lands
    /// inside the previous publish and hits the containment fast path
    /// instead of a fresh develop. `filterHalo` remains a separate, smaller
    /// addition applied on top by `decodeRect` for filter-stencil context
    /// only — it is never grown by this margin and is never itself
    /// published.
    static func patchRect(visibleRect: CGRect, imageSize: CGSize) -> CGRect {
        let base = detailRect(visibleRect: visibleRect, imageSize: imageSize)
        guard !base.isEmpty else { return base }
        let margin = panMargin(for: visibleRect)
        guard margin > 0 else { return base }
        let bounds = CGRect(origin: .zero, size: imageSize)
        let grown = base
            .insetBy(dx: -margin / 2, dy: -margin / 2)
            .integral
            .intersection(bounds)
        return grown.isNull ? base : grown
    }

    /// Source rect sent to the RAW tile entry. The halo gives clarity,
    /// sharpening, and NR context beyond the displayed patch without ever
    /// expanding work to the full sensor.
    ///
    /// The result is additionally clamped to `CanvasMath.metalMaxTextureEdge`
    /// per edge (#2061) — the halo inset only ever adds `2 * filterHalo`
    /// (192px) beyond the caller's `detailRect`, but a pathological
    /// viewport (an ultra-wide 2×-Retina display, or a very large source
    /// image) can still produce a `detailRect` whose expanded form would
    /// exceed the texture ceiling this tile is eventually uploaded into.
    /// Clamping the size here (keeping the origin fixed) is defensive:
    /// on ordinary hardware/viewports it never binds.
    static func decodeRect(detailRect: CGRect, imageSize: CGSize) -> CGRect {
        let bounds = CGRect(origin: .zero, size: imageSize)
        guard !detailRect.isEmpty, bounds.width > 0, bounds.height > 0 else {
            return .zero
        }
        let expanded = detailRect
            .insetBy(dx: -filterHalo, dy: -filterHalo)
            .integral
            .intersection(bounds)
        guard !expanded.isNull else { return .zero }
        let maxEdge = CanvasMath.metalMaxTextureEdge
        return CGRect(
            x: expanded.minX,
            y: expanded.minY,
            width: min(expanded.width, maxEdge),
            height: min(expanded.height, maxEdge)
        )
    }

    /// Convert a top-left-oriented source rect into the local CoreImage
    /// (bottom-left-origin) coordinates of its containing decode patch.
    static func localCoreImageRect(detailRect: CGRect, decodeRect: CGRect) -> CGRect {
        guard !detailRect.isEmpty, !decodeRect.isEmpty else { return .zero }
        let x = detailRect.minX - decodeRect.minX
        let top = detailRect.minY - decodeRect.minY
        let y = decodeRect.height - top - detailRect.height
        return CGRect(x: x, y: y, width: detailRect.width, height: detailRect.height)
    }
}

/// Session-scoped, single-handle visible-region renderer. The handle cache key
/// uses only decode-baked fields, so normal slider changes reuse the decoded
/// mosaic; changes such as highlight recovery reopen it correctly.
actor NativeDetailRenderer {
    private struct HandleKey: Equatable {
        let url: URL
        let sourceMtime: Date
        let bakedModel: AdjustmentModel
    }

    private var handleKey: HandleKey?
    private var handle: MapleRawHandle?

    func render(
        asset: AssetRef,
        sourceRect: CGRect,
        model: AdjustmentModel,
        aeGain: Float
    ) throws -> CIImage {
        guard !Task.isCancelled else { throw CancellationError() }
        guard let url = asset.primaryURL else { throw PipelineError.noByteSource }

        var bakedModel = RawCoreBridge.stripAppleGPUStages(model)
        bakedModel.profile = model.profile
        bakedModel.look = .default
        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        let accessing = scope.startAccessingSecurityScopedResource()
        defer { if accessing { scope.stopAccessingSecurityScopedResource() } }

        let key = HandleKey(
            url: url,
            sourceMtime: Self.modificationDate(for: url),
            bakedModel: bakedModel
        )

        // The Rust tile ABI accepts display-oriented source coordinates and
        // applies the RAW's EXIF orientation internally. Keep this rect in the
        // same oriented coordinate space as the canvas; mapping it back to
        // sensor axes here would rotate/flip it a second time.
        let x = Int(sourceRect.minX.rounded())
        let y = Int(sourceRect.minY.rounded())
        let width = Int(sourceRect.width.rounded())
        let height = Int(sourceRect.height.rounded())
        guard x >= 0, y >= 0, width > 0, height > 0,
              x <= Int(UInt32.max), y <= Int(UInt32.max),
              width <= Int(UInt32.max), height <= Int(UInt32.max)
        else {
            throw PipelineError.renderFailed(code: 9, message: "invalid native-detail geometry")
        }

        let rawHandle: MapleRawHandle
        if handleKey == key, let handle {
            rawHandle = handle
        } else {
            guard !Task.isCancelled else { throw CancellationError() }
            // Release the old handle BEFORE opening its replacement (#2061g):
            // a baked-field edit (e.g. highlight recovery) reopens the handle
            // with a different `bakedModel`, and holding both the old and
            // new decoded mosaics live at once transiently doubles resident
            // memory (~30-300MB each). Nil-ing here drops this actor's only
            // strong reference so `MapleRawHandle.deinit` (which calls
            // `maple_close_raw_handle`) can run before the new open begins.
            // If `openRawHandle` throws, the renderer is simply left
            // handle-less — actor state stays consistent (both fields nil)
            // and the next `render` call reopens fresh.
            handle = nil
            handleKey = nil
            let opened = try PipelineRenderer.openRawHandle(
                rawPath: url,
                model: model,
                profileOverride: model.profile
            )
            handleKey = key
            handle = opened
            rawHandle = opened
        }

        guard !Task.isCancelled else { throw CancellationError() }
        // #1945: use the f32 tile entry so this zoomed-in refinement path
        // carries the same working precision as the whole-image scene-linear
        // path (`ImageEditPipeline` uses `.RGBAf` end to end since #487). The
        // fp16 the tile path previously produced could bias shadows or band
        // the AgX shoulder specifically in the tile vs the full image.
        // NO decoded WB anchor (#1976): the handle's model is the STRIPPED
        // model, whose WB fields were omitted (`omitWhiteBalance`, #1883)
        // and therefore parse to the (6500, 0) defaults — NOT the live
        // slider values the #1725 anchor contract assumed ("the caller
        // hydrated the model to explicit values"). With an anchor, the
        // tile's camera-WB stage computes `wb(6500-default) / wb(anchor)`:
        // the old 6500/0 anchor made that identity only by accidental
        // cancellation (while still retargeting the DCP at 6500 instead of
        // as-shot), and any truthful anchor turns it into a warm cast. With
        // NO anchor the tile resolves WB exactly like the whole-image strip
        // decode — an As-Shot bake with the As-Shot DCP retarget — and the
        // live WB delta is applied once, downstream, by the per-tick chain
        // (`processSceneLinear`, anchored at `wbDeltaAnchor`). This matches
        // every other tile caller (TileManager deep zoom, preview tiles).
        //
        // `aeGain` (#1167/#2070): the caller passes the SAME `ae_gain` the
        // full-image (or sized) decode of this model exported, so the tile
        // reproduces the full-image auto-exposure brightness instead of
        // omitting the stage — the bug that gated this whole path to
        // `Profile::Auto` only (Auto's decode contract disables AE, so its
        // exported gain is always 1.0 and this call is a no-op for it;
        // Neutral/ACR-Match now get a real gain instead of falling back to
        // the bounded whole-image refine).
        let imageData = try PipelineRenderer.renderTileF32(
            handle: rawHandle,
            srcX: UInt32(x), srcY: UInt32(y),
            srcW: UInt32(width), srcH: UInt32(height),
            outW: UInt32(width), outH: UInt32(height),
            quality: .full,
            aeGain: aeGain
        )
        guard imageData.bytesPerPixel == 16 else {
            throw PipelineError.renderFailed(
                code: 9,
                message: "native-detail tile was not f32 RGBA"
            )
        }

        let colorSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return CIImage(
            bitmapData: imageData.pixels,
            bytesPerRow: imageData.width * imageData.bytesPerPixel,
            size: CGSize(width: imageData.width, height: imageData.height),
            format: .RGBAf,
            colorSpace: colorSpace
        )
    }

    private static func modificationDate(for url: URL) -> Date {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.modificationDate] as? Date) ?? .distantPast
    }
}
