// CropGeometry.swift — pure geometry for the interactive crop/straighten
// overlay (#638). Swift port of the web `crop-geometry.ts`; the function
// names and semantics match 1:1 so the two platforms can't drift on
// hit-testing, aspect locks, or the straighten preview math (the web
// `crop-geometry.spec.ts` and this file's `CropGeometryTests` assert the
// same invariants).
//
// No SwiftUI, no actor isolation — every function is a plain map over
// explicit inputs so the handle-drag, aspect-lock, and straighten-preview
// math is unit-testable in isolation.
//
// Coordinate spaces:
//   • normalized — the `Crop` rect edges in [0, 1] against the
//     display-oriented image (post-EXIF). This is exactly what the
//     pipeline / XMP consume.
//   • footprint  — the image's on-screen rect in points at FIT zoom,
//     centered in the viewport (the crop tool forces fit + zero pan, so
//     the displayed image always maps 1:1 onto this rect).
//
// The straighten preview rotates the displayed IMAGE by `angle` while the
// crop rectangle stays axis-aligned — mirroring the renderer's "rotate the
// frame, then cut an axis-aligned rect" model (spec § 3.12). The preview
// applies no corner fill, matching the renderer, so a near-edge crop
// reveals the same corner in both preview and output.

import Foundation
import CoreGraphics

public enum CropGeometry {
    /// Minimum crop rectangle size as a fraction of each image axis. Stops
    /// a drag from collapsing the rect to zero (and keeps both renderer +
    /// overlay sane). Matches the web `MIN_CROP_FRACTION`.
    public static let minCropFraction: Double = 0.05

    // MARK: - Types

    /// The image's on-screen rect (points) at fit zoom, centered in the
    /// viewport.
    public struct Footprint: Equatable, Sendable {
        public var left: Double
        public var top: Double
        public var width: Double
        public var height: Double

        public init(left: Double, top: Double, width: Double, height: Double) {
            self.left = left
            self.top = top
            self.width = width
            self.height = height
        }
    }

    /// A screen-space rectangle in points.
    public struct PxRect: Equatable, Sendable {
        public var x: Double
        public var y: Double
        public var width: Double
        public var height: Double

        public init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x
            self.y = y
            self.width = width
            self.height = height
        }
    }

    /// Handles the user can grab: 4 corners, 4 edge midpoints, plus the
    /// interior (move).
    public enum Handle: String, Equatable, Sendable, CaseIterable {
        case tl, tr, bl, br, t, b, l, r, move
    }

    // MARK: - Footprint / mapping

    /// Fit footprint: the largest centered rect of the image's aspect that
    /// fits the viewport without upscaling past 1:1 — the same rule as
    /// `CanvasMath.fitPixelScale`, so the overlay aligns with the painted
    /// image.
    public static func fitFootprint(
        wrapW: Double, wrapH: Double, imgW: Double, imgH: Double
    ) -> Footprint {
        let safeImgW = imgW > 0 ? imgW : 1
        let safeImgH = imgH > 0 ? imgH : 1
        let scale = min(wrapW / safeImgW, wrapH / safeImgH, 1)
        let width = safeImgW * scale
        let height = safeImgH * scale
        return Footprint(
            left: (wrapW - width) / 2,
            top: (wrapH - height) / 2,
            width: width,
            height: height
        )
    }

    /// Crop rect (normalized) → screen rect (points) over the footprint.
    public static func cropRectToPx(_ crop: Crop, _ fp: Footprint) -> PxRect {
        PxRect(
            x: fp.left + crop.left * fp.width,
            y: fp.top + crop.top * fp.height,
            width: (crop.right - crop.left) * fp.width,
            height: (crop.bottom - crop.top) * fp.height
        )
    }

    /// Screen point (points, viewport-relative) → normalized image coords,
    /// clamped to [0, 1]. Inverse of the footprint map.
    public static func pxToNormalized(
        _ px: Double, _ py: Double, _ fp: Footprint
    ) -> (nx: Double, ny: Double) {
        let nx = fp.width > 0 ? (px - fp.left) / fp.width : 0
        let ny = fp.height > 0 ? (py - fp.top) / fp.height : 0
        return (clamp01(nx), clamp01(ny))
    }

    // MARK: - Hit testing

    /// Which handle (if any) the pointer hit. Corners win over edges; the
    /// interior is `.move`. `tol` is the grab radius in points. Returns
    /// `nil` outside the rect + tolerance.
    public static func hitTestHandle(
        _ px: Double, _ py: Double, _ rect: PxRect, _ tol: Double
    ) -> Handle? {
        let left = rect.x
        let right = rect.x + rect.width
        let top = rect.y
        let bottom = rect.y + rect.height

        let nearL = abs(px - left) <= tol
        let nearR = abs(px - right) <= tol
        let nearT = abs(py - top) <= tol
        let nearB = abs(py - bottom) <= tol
        let withinX = px >= left - tol && px <= right + tol
        let withinY = py >= top - tol && py <= bottom + tol

        if nearL && nearT { return .tl }
        if nearR && nearT { return .tr }
        if nearL && nearB { return .bl }
        if nearR && nearB { return .br }
        if nearT && withinX { return .t }
        if nearB && withinX { return .b }
        if nearL && withinY { return .l }
        if nearR && withinY { return .r }
        if withinX && withinY { return .move }
        return nil
    }

    // MARK: - Resize

    /// Resize options for a handle drag. `aspect` (width / height of the
    /// FINAL image-space rect) locks the proportions; `nil` is a free crop.
    public struct ResizeOptions: Equatable, Sendable {
        /// Locked aspect as image-space width:height, or `nil` for free.
        public var aspect: Double?
        /// Image pixel dimensions, needed to honor a pixel aspect against
        /// the normalized rect (which is relative to each axis independently).
        public var imgW: Double
        public var imgH: Double

        public init(aspect: Double?, imgW: Double, imgH: Double) {
            self.aspect = aspect
            self.imgW = imgW
            self.imgH = imgH
        }
    }

    /// Apply a handle drag to a crop rect. `nx`/`ny` are the dragged pointer
    /// in normalized image coords. Edges are clamped so the rect keeps at
    /// least `minCropFraction` on each axis and never inverts; an aspect
    /// lock recomputes the free edge from the dragged one about the
    /// opposite/anchor corner.
    public static func resizeCrop(
        _ crop: Crop, _ handle: Handle, _ nx: Double, _ ny: Double, _ opts: ResizeOptions
    ) -> Crop {
        var next = crop
        let movesLeft = handle == .tl || handle == .bl || handle == .l
        let movesRight = handle == .tr || handle == .br || handle == .r
        let movesTop = handle == .tl || handle == .tr || handle == .t
        let movesBottom = handle == .bl || handle == .br || handle == .b

        if movesLeft { next.left = min(nx, crop.right - minCropFraction) }
        if movesRight { next.right = max(nx, crop.left + minCropFraction) }
        if movesTop { next.top = min(ny, crop.bottom - minCropFraction) }
        if movesBottom { next.bottom = max(ny, crop.top + minCropFraction) }

        next.left = clamp01(next.left)
        next.right = clamp01(next.right)
        next.top = clamp01(next.top)
        next.bottom = clamp01(next.bottom)

        if let aspect = opts.aspect, aspect > 0 {
            applyAspect(&next, handle: handle, opts: opts)
        }
        return next
    }

    /// Recompute the free axis so the rect's IMAGE-space proportions equal
    /// `aspect` (width:height in pixels), anchoring on the edge(s) the
    /// handle did NOT move.
    private static func applyAspect(
        _ next: inout Crop, handle: Handle, opts: ResizeOptions
    ) {
        guard let aspect = opts.aspect else { return }
        let imgW = opts.imgW
        let imgH = opts.imgH
        // Target normalized width / height ratio so that
        // (w_norm·imgW) / (h_norm·imgH) === aspect.
        let ratioNorm = aspect * (imgH / imgW) // w_norm / h_norm

        let widthDriven = handle == .l || handle == .r
        let heightDriven = handle == .t || handle == .b

        var w = next.right - next.left
        var h = next.bottom - next.top

        if widthDriven {
            h = w / ratioNorm
        } else if heightDriven {
            w = h * ratioNorm
        } else {
            // Corner: drive by width.
            h = w / ratioNorm
        }

        // Re-anchor: keep the corner opposite the moved handle fixed.
        let anchorRight = handle == .tl || handle == .bl || handle == .l
        let anchorBottom = handle == .tl || handle == .tr || handle == .t

        if anchorRight {
            next.left = next.right - w
        } else {
            next.right = next.left + w
        }
        if anchorBottom {
            next.top = next.bottom - h
        } else {
            next.bottom = next.top + h
        }

        // If the aspect push ran a corner/edge off the image, scale back to
        // fit while preserving the ratio and the anchor.
        let overflow = max(
            next.left < 0 ? -next.left / max(w, 1e-6) : 0,
            next.right > 1 ? (next.right - 1) / max(w, 1e-6) : 0,
            next.top < 0 ? -next.top / max(h, 1e-6) : 0,
            next.bottom > 1 ? (next.bottom - 1) / max(h, 1e-6) : 0
        )
        if overflow > 0 {
            let scale = 1 - overflow
            let nw = w * scale
            let nh = h * scale
            if anchorRight { next.left = next.right - nw } else { next.right = next.left + nw }
            if anchorBottom { next.top = next.bottom - nh } else { next.bottom = next.top + nh }
        }

        next.left = clamp01(next.left)
        next.right = clamp01(next.right)
        next.top = clamp01(next.top)
        next.bottom = clamp01(next.bottom)
    }

    // MARK: - Move

    /// Translate the whole crop rect by a normalized delta, clamped so it
    /// stays inside the image without resizing.
    public static func moveCrop(_ crop: Crop, _ dnx: Double, _ dny: Double) -> Crop {
        let w = crop.right - crop.left
        let h = crop.bottom - crop.top
        var left = crop.left + dnx
        var top = crop.top + dny
        left = max(0, min(left, 1 - w))
        top = max(0, min(top, 1 - h))
        var next = crop
        next.left = left
        next.top = top
        next.right = left + w
        next.bottom = top + h
        return next
    }

    // MARK: - Aspect presets

    /// Build a centered crop rect of the given IMAGE-space aspect
    /// (width:height in pixels), as large as fits the frame. Used by the
    /// aspect-ratio presets. Preserves the straighten `angle`.
    public static func centeredCropForAspect(
        _ aspect: Double, _ imgW: Double, _ imgH: Double, _ angle: Double
    ) -> Crop {
        guard aspect > 0, imgW > 0, imgH > 0 else {
            return Crop(top: 0, left: 0, bottom: 1, right: 1, angle: angle)
        }
        let imgAspect = imgW / imgH
        let w: Double
        let h: Double
        if aspect >= imgAspect {
            // Crop is wider than the image — span full width, trim height.
            w = 1
            h = imgAspect / aspect
        } else {
            h = 1
            w = aspect / imgAspect
        }
        let left = (1 - w) / 2
        let top = (1 - h) / 2
        return Crop(top: top, left: left, bottom: top + h, right: left + w, angle: angle)
    }

    // MARK: - Helpers

    static func clamp01(_ v: Double) -> Double { max(0, min(1, v)) }
}
