// LocalHistogram.swift — on-device RGB histogram for local & PhotoKit assets.
//
// The S6 Info panel's HistogramBlock shows live RGB curves. For Self-Hosted
// assets it fetches `GET /api/assets/:id/histogram` (CloudHistogramClient);
// for filesystem and PhotoKit assets — which have no server-minted asset id —
// this computes the SAME 3×256 histogram on device via the Rust core, so the
// histogram works on every platform (Mac / iPad / iPhone) regardless of where
// the asset lives.
//
// The histogram reflects the live in-memory edit: the current `AdjustmentModel`
// + `CullingState` are serialised to an XMP document and handed to the bytes
// FFI (`maple_histogram_bytes`), which develops the RAW under those adjustments
// and bins the result. Preview quality keeps the on-edit-settle recompute light
// (a histogram is a statistical reduction — the half-res demosaic is visually
// identical to full quality and ~4× cheaper).

import Foundation

/// On-device RGB histogram computation for local sources. Stateless namespace;
/// every call decodes + develops + bins via the Rust FFI and returns the same
/// `CloudHistogram` wire shape the server produces.
public enum LocalHistogram {
  /// Compute an RGB histogram for `asset` under the given edit state, on device.
  ///
  /// Reads the RAW bytes (filesystem URL or PhotoKit bytes provider), serialises
  /// `model` + `culling` to an XMP document so the histogram reflects the live
  /// edit, and develops at preview quality.
  ///
  /// Safe to call off the main actor — it does no UI work and only touches
  /// `Sendable` inputs. Throws `PipelineError.noByteSource` when the asset has
  /// neither a URL nor a bytes provider, and `PipelineError.renderFailed` when
  /// the FFI decode/render fails (e.g. a non-RAW image, which the Rust decoder
  /// does not handle); callers fall back to the placeholder on any throw.
  public static func compute(
    asset: AssetRef,
    model: AdjustmentModel,
    culling: CullingState
  ) async throws -> CloudHistogram {
    // Serialise the live model so the histogram tracks the current edit. A
    // sourceless asset has no `.xmp` on disk, so we hand the document text
    // straight to the FFI rather than a path.
    let xmpDocument = XMPSerializer.serialize(model: model, culling: culling)

    let rawBytes: Data
    let hint: String
    if let url = asset.primaryURL {
      // Security-scoped read mirrors `ImageEditPipeline`'s FFI reads: the scope
      // claim MUST be on the bookmark-resolved ancestor (`scopeParentURL`), not
      // a path-reconstructed parent — the latter carries no scope token and
      // `startAccessing` silently no-ops, so the read would hit EPERM under the
      // sandbox.
      let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
      let accessing = scope.startAccessingSecurityScopedResource()
      defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
      rawBytes = try Data(contentsOf: url)
      hint = url.pathExtension
    } else if let provider = asset.bytesProvider {
      rawBytes = try await provider()
      hint = asset.hintExtension ?? ""
    } else {
      throw PipelineError.noByteSource
    }

    return try PipelineRenderer.histogram(
      rawBytes: rawBytes,
      hint: hint,
      xmpDocument: xmpDocument,
      quality: .preview
    )
  }
}
