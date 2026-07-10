// EditSession+Preview.swift — SwiftUI preview construction.

import Foundation

@MainActor
extension EditSession {
    /// Sample `EditSession` for SwiftUI `#Preview` blocks. Constructed against
    /// `AssetRef.preview()` and the default `AdjustmentModel`; no rendering is
    /// kicked off because there is no real asset on disk. Issue #139.
    public static func preview(
        displayName: String = "IMG_0042.dng",
        model: AdjustmentModel = .default,
        culling: CullingState = CullingState()
    ) -> EditSession {
        EditSession(
            asset: AssetRef.preview(displayName: displayName),
            model: model,
            culling: culling
        )
    }
}
