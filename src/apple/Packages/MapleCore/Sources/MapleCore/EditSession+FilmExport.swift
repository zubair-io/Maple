// EditSession+FilmExport.swift — full-quality export with a film look
// baked in (epic #2683, Task 10).
//
// `renderForExport()` (`EditSession+RenderHelpers.swift`) normally routes
// through `RenderActor.renderForExport`'s CIImage graph
// (`ImageEditPipeline.processSceneLinear`), which threads the LIVE
// in-memory `AdjustmentModel` straight through the per-tick FFI chain
// (`maple_apply_scene_linear_chain_f32`) — that struct has no film-look
// field (raw-ffi scope, out of Task 10's Apple-only surface), so it cannot
// blend a look. `maple_render_file_with_film` (Task 8) CAN, but it is a
// full decode→develop→render entry that reads its adjustments off the
// ON-DISK XMP sidecar rather than taking a model directly — so this path
// is reserved for the export action (one bounded, user-initiated render,
// where flushing the debounced sidecar write first is a fully acceptable
// one-time cost) and NOT for interactive refine ticks, where redoing a full
// RAW decode every ~150ms settle would blow the performance budget.

import Foundation
import CoreImage

@MainActor
extension EditSession {
    /// When `model.filmLook` resolves to a lattice AND `asset` is a
    /// filesystem-backed RAW, render the export via
    /// `maple_render_file_with_film` and return the resulting CIImage;
    /// `nil` when film-look export doesn't apply (no look, non-RAW,
    /// sourceless asset) or the FFI render itself failed — either case
    /// falls through to the normal CIImage-graph export at the call site.
    func renderExportWithFilmLook() async throws -> CIImage? {
        guard asset.isRaw, !model.filmLook.isEmpty,
              let url = asset.primaryURL,
              let lut = filmLutStore.lattice(for: model.filmLook)
        else { return nil }

        // The FFI reads adjustments off DISK — flush the debounced sidecar
        // write first so the export reflects THIS session's live model, not
        // a stale on-disk snapshot (the CIImage-graph path avoids this
        // entirely by taking `model` directly).
        await flushPendingSidecarWrite()

        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        let accessing = scope.startAccessingSecurityScopedResource()
        defer { if accessing { scope.stopAccessingSecurityScopedResource() } }

        let quality: PipelineRenderer.Quality = AmazeFlag.isEnabled ? .amaze : .full
        let data: MapleImageData
        do {
            data = try PipelineRenderer.render(
                rawPath: url,
                xmpPath: asset.sidecarURL,
                quality: quality,
                filmLut: lut
            )
        } catch {
            editSessionLogger.error(
                "film-look export render failed: \(error.localizedDescription, privacy: .public) — falling back to the plain export chain")
            return nil
        }
        return Self.ciImage(fromPackedSRGB: data)
    }

    /// Build a CIImage from a packed sRGB u8 RGB buffer (`MapleImageData`'s
    /// layout — `maple_render_file`/`maple_render_file_with_film`'s output).
    /// Mirrors `ImageEditPipeline`'s private decode-path conversion; kept
    /// here rather than shared since this is the only non-decode caller.
    private static func ciImage(fromPackedSRGB data: MapleImageData) -> CIImage? {
        guard data.pixels.count == data.width * data.height * 3 else { return nil }
        let w = data.width, h = data.height
        let copy = data.pixels
        guard let dp = CGDataProvider(data: copy as CFData),
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let cgImage = CGImage(
                  width: w, height: h,
                  bitsPerComponent: 8, bitsPerPixel: 24,
                  bytesPerRow: w * 3,
                  space: colorSpace,
                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                  provider: dp,
                  decode: nil,
                  shouldInterpolate: true,
                  intent: .defaultIntent
              )
        else { return nil }
        return CIImage(cgImage: cgImage)
    }
}
