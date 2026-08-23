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

    @State private var isLoading = true

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
    }

    public var body: some View {
        ZStack {
            MuiImage(url: url, alt: alt, fit: fit, radius: radius, aspectRatio: aspectRatio)
            if isLoading {
                MuiSpinner(placement: .centered)
            }
        }
        .task(id: url) {
            guard let url else {
                isLoading = false
                return
            }
            isLoading = true
            // MuiImage resolves its own loaded/broken state asynchronously
            // off a background decode task; this mirrors that same window
            // rather than duplicating the decode itself, matching the web
            // reference's "reads mui-image's own signals" contract.
            _ = await MuiPlatformImage.load(from: url)
            isLoading = false
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
