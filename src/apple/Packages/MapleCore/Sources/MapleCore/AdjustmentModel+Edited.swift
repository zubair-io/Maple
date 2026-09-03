// AdjustmentModel+Edited.swift — the "has visible edits" predicate, split
// out of `AdjustmentModel.swift` (#358) to keep that file under the
// 570-line headroom budget once the local-adjustment layer stack landed on
// the model. Pure move — the predicate is unchanged.

import Foundation

extension AdjustmentModel {
    /// True when this model carries user adjustments that change the
    /// rendered pixels, judged with the white-balance fields excluded.
    ///
    /// `temperature`/`tint`/`wbScaleVersion` must be excluded: on first
    /// open the editor seeds them with the image's as-shot values, so a
    /// rating-only or flag-only sidecar save records non-default WB numbers
    /// that do NOT represent an edit. Comparing against a baseline that
    /// copies those three fields treats those sidecars as visually unedited
    /// — the common culling case — at the cost of also treating a WB-only
    /// edit as unedited. Callers that gate derived-image generation on this
    /// (the `.maple/previews` display tier in `ThumbnailLoader`) accept
    /// that trade-off: a WB-only edit made in the local editor still gets a
    /// correct display preview from the editor-exit render refresh; only a
    /// WB-only edit arriving externally (synced sidecar, never rendered on
    /// this device) slips through.
    ///
    /// `wbMethod` is NOT copied into the baseline (#2216): unlike
    /// temperature/tint, nothing seeds it from the image itself, so a
    /// non-default value only ever comes from an explicit user or
    /// externally-authored choice — a real edit, correctly caught here.
    public var isVisuallyEditedBeyondWhiteBalance: Bool {
        let baseline = AdjustmentModel(
            temperature: temperature,
            tint: tint,
            wbScaleVersion: wbScaleVersion
        )
        return self != baseline
    }
}
