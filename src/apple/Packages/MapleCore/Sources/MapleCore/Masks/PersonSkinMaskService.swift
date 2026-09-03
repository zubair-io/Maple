// PersonSkinMaskService.swift — Vision-backed person + skin segmentation
// (#3273, spec §6.1). Runs VNGeneratePersonInstanceMaskRequest (per-person
// instance masks) and VNDetectFaceRectanglesRequest (splits an instance into
// facial vs. body skin) over a caller-supplied CGImage. No downloads, no
// model provisioning — both requests ship in the OS at the macOS 14 / iOS 17
// floor this package already targets.
//
// The caller (EditSession, via MaskRasterStore) is responsible for producing
// the CGImage from a fresh, uncropped ~1MP develop — this service has no
// opinion on decode quality or crop state.

import CoreGraphics
import Vision

public struct PersonCandidate: Sendable, Identifiable, Equatable {
    public let id: Int
    /// Normalized [0,1], origin top-left, matching Maple's mask coordinate
    /// convention. Computed from the instance-mask's own labeled pixels
    /// (exact), not approximated from a face box.
    public let boundingBox: CGRect

    public init(id: Int, boundingBox: CGRect) {
        self.id = id
        self.boundingBox = boundingBox
    }
}

public struct SkinRasterRequest: Sendable, Equatable {
    public let person: Int
    public let facialSkin: Bool
    public let bodySkin: Bool

    public init(person: Int, facialSkin: Bool, bodySkin: Bool) {
        self.person = person
        self.facialSkin = facialSkin
        self.bodySkin = bodySkin
    }
}

public enum PersonSkinMaskError: Error, Equatable {
    case noPersonDetected
    case visionFailed(String)
}

public actor PersonSkinMaskService {
    public init() {}

    /// Every detected person's index + normalized (top-left-origin) bounding
    /// box, for the people picker. Throws `.noPersonDetected` when Vision
    /// finds nobody.
    public func detectPersons(in image: CGImage) async throws -> [PersonCandidate] {
        let request = VNGeneratePersonInstanceMaskRequest()
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            throw PersonSkinMaskError.visionFailed(error.localizedDescription)
        }
        guard let result = request.results?.first else {
            throw PersonSkinMaskError.noPersonDetected
        }
        let instances = result.allInstances.sorted()
        if instances.isEmpty {
            throw PersonSkinMaskError.noPersonDetected
        }
        let extents = instanceExtents(result.instanceMask, labels: instances)
        return instances.enumerated().map { offset, label in
            PersonCandidate(id: offset, boundingBox: extents[label] ?? CGRect(x: 0, y: 0, width: 1, height: 1))
        }
    }

    /// Build an R8 raster (row-major, `width × height` bytes, 0…255) for the
    /// requested person's skin. `width`/`height` are the CALLER's `image`
    /// dims — the raster is NOT resampled here; `MaskRasterStore` owns the
    /// 1024px-long-edge policy.
    public func makeRaster(image: CGImage, request: SkinRasterRequest) async throws -> (width: Int, height: Int, bytes: [UInt8]) {
        let personRequest = VNGeneratePersonInstanceMaskRequest()
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([personRequest])
        } catch {
            throw PersonSkinMaskError.visionFailed(error.localizedDescription)
        }
        guard let result = personRequest.results?.first else {
            throw PersonSkinMaskError.noPersonDetected
        }
        let instances = result.allInstances.sorted()
        guard request.person >= 0, request.person < instances.count else {
            throw PersonSkinMaskError.noPersonDetected
        }
        let label = instances[request.person]
        let maskPixelBuffer: CVPixelBuffer
        do {
            maskPixelBuffer = try result.generateMaskedImage(
                ofInstances: IndexSet(integer: label), from: handler, croppedToInstancesExtent: false
            )
        } catch {
            throw PersonSkinMaskError.visionFailed(error.localizedDescription)
        }
        var instanceMask = alphaMaskToR8(maskPixelBuffer, targetWidth: image.width, targetHeight: image.height)

        if !request.facialSkin || !request.bodySkin {
            let faceRequest = VNDetectFaceRectanglesRequest()
            try? handler.perform([faceRequest])
            let faceMask = rasterizeFaceBoxes(
                (faceRequest.results ?? []).map { $0.boundingBox },
                width: image.width, height: image.height, dilate: 1.2
            )
            for i in 0..<instanceMask.count {
                let inFace = faceMask[i] > 0
                let keep = (request.facialSkin && inFace) || (request.bodySkin && !inFace)
                if !keep { instanceMask[i] = 0 }
            }
        }
        return (image.width, image.height, instanceMask)
    }

    // MARK: - Private helpers

    /// Exact top-left-origin normalized bounding box per instance label,
    /// scanned directly from the observation's own labeled pixel buffer
    /// (0 = background, N = the Nth instance). `VNInstanceMaskObservation`
    /// has no first-class per-instance bounding-box API in this SDK (checked
    /// against the macOS 14 Vision.framework headers) — the mask buffer
    /// itself is the only source of truth for instance extent.
    private func instanceExtents(_ buffer: CVPixelBuffer, labels: [Int]) -> [Int: CGRect] {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let w = CVPixelBufferGetWidth(buffer)
        let h = CVPixelBufferGetHeight(buffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        guard let base = CVPixelBufferGetBaseAddress(buffer), w > 0, h > 0 else { return [:] }

        var minX = [Int: Int](), maxX = [Int: Int](), minY = [Int: Int](), maxY = [Int: Int]()
        func visit(_ label: Int, _ x: Int, _ y: Int) {
            guard label != 0 else { return }
            minX[label] = Swift.min(minX[label] ?? x, x)
            maxX[label] = Swift.max(maxX[label] ?? x, x)
            minY[label] = Swift.min(minY[label] ?? y, y)
            maxY[label] = Swift.max(maxY[label] ?? y, y)
        }

        let pixelFormat = CVPixelBufferGetPixelFormatType(buffer)
        if pixelFormat == kCVPixelFormatType_OneComponent32Float {
            let stride = rowBytes / MemoryLayout<Float32>.size
            let ptr = base.assumingMemoryBound(to: Float32.self)
            for y in 0..<h {
                for x in 0..<w { visit(Int(ptr[y * stride + x].rounded()), x, y) }
            }
        } else {
            // Observed in practice as 8-bit instance indices; also the
            // fallback for any other integer-labeled format.
            let ptr = base.assumingMemoryBound(to: UInt8.self)
            for y in 0..<h {
                for x in 0..<w { visit(Int(ptr[y * rowBytes + x]), x, y) }
            }
        }

        var out = [Int: CGRect]()
        for label in labels {
            guard let x0 = minX[label], let x1 = maxX[label], let y0 = minY[label], let y1 = maxY[label] else { continue }
            out[label] = CGRect(
                x: CGFloat(x0) / CGFloat(w),
                y: CGFloat(y0) / CGFloat(h),
                width: CGFloat(x1 - x0 + 1) / CGFloat(w),
                height: CGFloat(y1 - y0 + 1) / CGFloat(h)
            )
        }
        return out
    }

    /// `generateMaskedImage` returns an RGBA buffer with the selected
    /// instances' original colour and alpha = coverage, everything else
    /// transparent black — read the alpha channel as the R8 coverage mask.
    private func alphaMaskToR8(_ buffer: CVPixelBuffer, targetWidth: Int, targetHeight: Int) -> [UInt8] {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let srcW = CVPixelBufferGetWidth(buffer)
        let srcH = CVPixelBufferGetHeight(buffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        guard let base = CVPixelBufferGetBaseAddress(buffer), srcW > 0, srcH > 0 else {
            return [UInt8](repeating: 0, count: targetWidth * targetHeight)
        }
        let src = base.assumingMemoryBound(to: UInt8.self)
        // BGRA8/ARGB8-family buffers from Vision's masked-image output are
        // 4 bytes/pixel with alpha as the last byte (BGRA little-endian).
        let alphaOffset = 3
        var out = [UInt8](repeating: 0, count: targetWidth * targetHeight)
        for y in 0..<targetHeight {
            let sy = min(srcH - 1, (y * srcH) / max(targetHeight, 1))
            for x in 0..<targetWidth {
                let sx = min(srcW - 1, (x * srcW) / max(targetWidth, 1))
                out[y * targetWidth + x] = src[sy * rowBytes + sx * 4 + alphaOffset]
            }
        }
        return out
    }

    private func rasterizeFaceBoxes(_ boxes: [CGRect], width: Int, height: Int, dilate: CGFloat) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: width * height)
        for box in boxes {
            let cx = box.midX, cy = box.midY
            let hw = box.width * dilate / 2, hh = box.height * dilate / 2
            let x0 = max(0, Int((cx - hw) * CGFloat(width)))
            let x1 = min(width, Int((cx + hw) * CGFloat(width)))
            // Vision's face boundingBox is bottom-left origin; flip to
            // top-left for the raster.
            let y0 = max(0, Int((1 - cy - hh) * CGFloat(height)))
            let y1 = min(height, Int((1 - cy + hh) * CGFloat(height)))
            guard x0 < x1, y0 < y1 else { continue }
            for y in y0..<y1 {
                for x in x0..<x1 { out[y * width + x] = 255 }
            }
        }
        return out
    }
}
