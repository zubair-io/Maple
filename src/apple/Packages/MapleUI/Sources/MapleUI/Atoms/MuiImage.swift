// MuiImage.swift — Maple UI Image atom.
// Contract: docs/design/maple-ui/components/image.md

import SwiftUI

public enum MuiImageFit: Sendable {
    case fill, fit
}

public enum MuiImageRadius: Sendable {
    case none, sm, md, lg, full

    var points: CGFloat {
        switch self {
        case .none: return 0
        case .sm: return MuiTokens.radiusSm
        case .md: return MuiTokens.radiusMd
        case .lg: return MuiTokens.radiusLg
        case .full: return MuiTokens.radiusFull
        }
    }
}

/// A raster leaf for a locally-available image — an already-resolved file
/// or blob URL (image.md §Purpose). Distinct from `MuiRemoteImage`, which
/// owns the network/cache/tiered-load lifecycle; this atom just draws
/// whatever `url` it's given and handles the fit/broken/loading chrome
/// around it.
public struct MuiImage: View {
    public let url: URL?
    public let alt: String
    public let fit: MuiImageFit
    public let radius: MuiImageRadius
    public let aspectRatio: CGFloat?
    public let onSettled: (() -> Void)?

    @State private var phase: Phase = .loading
    @State private var resolvedImage: Image?

    private enum Phase: Equatable {
        case loading, loaded, broken
    }

    /// - Parameter onSettled: called once this load resolves to `.loaded`
    ///   or `.broken` (including the synchronous "no url" case) — lets a
    ///   composing view (e.g. `MuiPreviewImage`) observe this atom's own
    ///   load lifecycle instead of running a second, duplicate decode of
    ///   the same url just to know when it's done.
    public init(
        url: URL?,
        alt: String,
        fit: MuiImageFit = .fill,
        radius: MuiImageRadius = .md,
        aspectRatio: CGFloat? = nil,
        onSettled: (() -> Void)? = nil
    ) {
        self.url = url
        self.alt = alt
        self.fit = fit
        self.radius = radius
        self.aspectRatio = aspectRatio
        self.onSettled = onSettled
    }

    public var body: some View {
        ZStack {
            MuiTokens.surfaceAlt
            if phase == .loaded, let resolvedImage {
                resolvedImage
                    .resizable()
                    .aspectRatio(contentMode: fit == .fill ? .fill : .fit)
                    .transition(.opacity)
            } else if phase == .broken {
                MuiIcon(name: "photo", size: .lg, color: MuiTokens.textMuted)
            }
        }
        .aspectRatio(aspectRatio, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: radius.points, style: .continuous))
        .clipped()
        .animation(.easeInOut(duration: MuiTokens.hoverPressSeconds), value: phase)
        .task(id: url) { await load() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(alt)
        .accessibilityAddTraits(.isImage)
    }

    private func load() async {
        guard let url else {
            phase = .broken
            onSettled?()
            return
        }
        phase = .loading
        let image = await MuiPlatformImage.load(from: url)
        // A url change while this decode was in flight cancels the task
        // backing this call (`.task(id: url)`) and starts a fresh one for
        // the new url; skip applying this stale result so a cancelled
        // decode can't stomp the new load's `.loading` phase or fire
        // `onSettled` (and drop `MuiPreviewImage`'s spinner) out of turn.
        guard !Task.isCancelled else { return }
        if let image {
            resolvedImage = image
            phase = .loaded
        } else {
            resolvedImage = nil
            phase = .broken
        }
        onSettled?()
    }
}

#Preview("MuiImage — Fit modes") {
    HStack(spacing: 12) {
        MuiImage(url: nil, alt: "Broken example", fit: .fill)
            .frame(width: 96, height: 96)
        MuiImage(url: nil, alt: "Broken example", fit: .fit)
            .frame(width: 96, height: 96)
    }
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiImage — Radius tiers") {
    HStack(spacing: 12) {
        MuiImage(url: nil, alt: "Placeholder", radius: .none).frame(width: 56, height: 56)
        MuiImage(url: nil, alt: "Placeholder", radius: .sm).frame(width: 56, height: 56)
        MuiImage(url: nil, alt: "Placeholder", radius: .lg).frame(width: 56, height: 56)
        MuiImage(url: nil, alt: "Placeholder", radius: .full).frame(width: 56, height: 56)
    }
    .padding()
    .background(MuiTokens.bg)
}
