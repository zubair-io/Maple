// RenderActor.swift — actor boundary for the per-image render pipeline.
//
// Slice 1 of 3 — issue #194. This file introduces the `RenderActor` type
// as a thin pass-through over `ImageEditPipeline` so the actor boundary
// can be exercised by callers and tests without yet moving any state off
// `EditSession`. Slices 2 and 3 migrate the decoded-image cache and the
// render scheduler in turn.
//
// Surface today (slice 1):
//   • `init(pipeline:)` — accepts the shared `ImageEditPipeline` actor.
//   • `renderPreview(asset:model:)` — decode + process a single CIImage,
//     delegating to the existing scene-linear chain. No caching, no
//     scheduling, no generation guard — those move in later slices.
//
// What slice 1 deliberately does NOT move:
//   • decoded-image cache fields (`decodedImage`, `decodedAtModel`, …) —
//     still live on `EditSession`. Slice 2 moves them.
//   • render scheduling (`_scheduleRender`, `_scheduleRefine`,
//     refine-decode coalescer, generation counter) — still on
//     `EditSession`. Slice 3 moves them.
//
// EditSession holds a `let renderActor: RenderActor` so future slices have
// a stable construction point, but no caller is routed through it yet.

import Foundation
import CoreImage

/// Per-session actor boundary for the render pipeline.
///
/// Isolation owns nothing meaningful in slice 1 — the only stored property
/// is the shared `ImageEditPipeline` actor reference, which is itself
/// `Sendable`. The point of slice 1 is to establish the boundary so
/// subsequent slices can move state across it incrementally.
public actor RenderActor {
    /// Shared GPU pipeline (Metal kernels + `CIContext`). Constructed by
    /// `EditSession` and handed in — keeping a single `ImageEditPipeline`
    /// per session preserves the current GPU-resource lifetime.
    private let pipeline: ImageEditPipeline

    public init(pipeline: ImageEditPipeline) {
        self.pipeline = pipeline
    }

    /// Render a preview CIImage for `asset` against `model`.
    ///
    /// Slice 1: this is a thin pass-through over `ImageEditPipeline`'s
    /// scene-linear decode + process chain — the same path that
    /// `EditSession+Decode.renderForExport` walks for export. No cache,
    /// no target-size hint, no generation guard. Returns a CIImage at the
    /// pipeline's preview-quality resolution.
    ///
    /// Throws `RenderError.pipelineFailed` if decode returns nil (unreadable
    /// asset, FFI error, non-RAW path with no bytes). Callers that need
    /// cancellation should wrap the call in a `Task` and cancel that.
    public func renderPreview(
        asset: AssetRef,
        model: AdjustmentModel
    ) async throws -> CIImage {
        // Non-RAW path: ImageIO decode + non-RAW kernel chain. Mirrors the
        // dispatch in `EditSession+Decode.renderForExport` so slice 1 stays
        // semantically equivalent to what callers get today.
        if !asset.isRaw {
            guard let decoded = await pipeline.decodeSceneLinearNonRaw(
                asset: asset, targetSize: nil
            ) else {
                throw RenderError.pipelineFailed
            }
            let pipelineRef = pipeline
            return await Task.detached(priority: .userInitiated) {
                pipelineRef.processSceneLinearNonRaw(
                    decoded: decoded, model: model, targetSize: nil
                )
            }.value
        }

        // RAW path: forward the sidecar URL (if any) so highlight_recovery
        // is applied pre-DCP. Slice 1 doesn't try to share the decode with
        // EditSession's cached buffer — that's the slice 2 work.
        let sidecar: URL? = {
            guard let url = asset.sidecarURL,
                  FileManager.default.fileExists(atPath: url.path)
            else { return nil }
            return url
        }()
        guard let decoded = await pipeline.decodeSceneLinear(
            asset: asset, quality: .preview, xmpPath: sidecar
        ) else {
            throw RenderError.pipelineFailed
        }
        let pipelineRef = pipeline
        return await Task.detached(priority: .userInitiated) {
            pipelineRef.processSceneLinear(
                decoded: decoded,
                model: model,
                targetSize: nil,
                asShot: nil,
                decodedAtModel: nil
            )
        }.value
    }
}
