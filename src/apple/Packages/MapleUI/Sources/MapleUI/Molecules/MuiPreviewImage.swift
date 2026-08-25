// MuiPreviewImage.swift — Maple UI Molecules-L1 (unified-component-
// catalog.md §2.7; Built from: Image, Spinner). A static image with a load
// lifecycle: a centered spinner overlay until MuiImage settles into its
// own loaded/broken state.

import SwiftUI

public struct MuiPreviewImage: View {
    public let url: URL?
    public let alt: String
    public let fit: MuiImageFit
    public let radius: MuiImageRadius
    public let aspectRatio: CGFloat?

    @State private var isLoading: Bool

    public init(
        url: URL?,
        alt: String,
        fit: MuiImageFit = .fill,
        radius: MuiImageRadius = .md,
        aspectRatio: CGFloat? = nil
    ) {
        self.url = url
        self.alt = alt
        self.fit = fit
        self.radius = radius
        self.aspectRatio = aspectRatio
        self._isLoading = State(initialValue: url != nil)
    }

    public var body: some View {
        ZStack {
            // MuiImage owns the one-and-only decode of `url`; this view
            // never decodes it a second time — it just observes MuiImage's
            // own load lifecycle via `onSettled` to know when to drop the
            // spinner, matching the web reference's "reads mui-image's own
            // signals" contract.
            MuiImage(
                url: url, alt: alt, fit: fit, radius: radius, aspectRatio: aspectRatio,
                onSettled: { isLoading = false }
            )
            if isLoading {
                MuiSpinner(placement: .centered)
            }
        }
        .onChange(of: url) { _, newURL in
            isLoading = newURL != nil
        }
    }
}

#Preview("MuiPreviewImage") {
    HStack(spacing: 12) {
        MuiPreviewImage(url: nil, alt: "Broken example")
            .frame(width: 96, height: 96)
    }
    .padding()
    .background(MuiTokens.bg)
}
