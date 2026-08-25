// MuiRemoteImage.swift — Maple UI Remote Image atom.
// Contract: docs/design/maple-ui/components/remote-image.md

import SwiftUI

public enum MuiRemoteImageTier: Sendable {
    case thumb, preview, full
}

/// At least one URL, loaded in `thumb -> preview -> full` priority order
/// (remote-image.md §Props). A caller with only a `full` URL still gets the
/// same loading/error chrome, just a single-tier sequence.
public struct MuiRemoteImageTiers: Sendable {
    public let thumb: URL?
    public let preview: URL?
    public let full: URL?

    public init(thumb: URL? = nil, preview: URL? = nil, full: URL? = nil) {
        self.thumb = thumb
        self.preview = preview
        self.full = full
    }

    var ordered: [(MuiRemoteImageTier, URL)] {
        [(.thumb, thumb), (.preview, preview), (.full, full)]
            .compactMap { tier, url in url.map { (tier, $0) } }
    }
}

enum MuiRemoteImageError: Error {
    case decodeFailed
}

/// Drives the tiered load sequence — factored out of the view so the
/// state machine is unit-testable against an injected loader closure
/// without rendering anything (remote-image.md §States: never regress to a
/// blurrier tier once a sharper one has loaded).
@MainActor
public final class MuiRemoteImageController: ObservableObject {
    @Published public private(set) var image: Image?
    @Published public private(set) var tier: MuiRemoteImageTier?
    @Published public private(set) var isLoading = true
    @Published public private(set) var isError = false

    private let loader: @Sendable (URL) async throws -> Image

    /// The tiers passed to the most recent `start(tiers:)` call — kept only
    /// so `retry()` knows what to reload; never captured once at `init` (a
    /// view whose `@StateObject` outlives a SwiftUI-reused identity must be
    /// able to feed this controller a *different* set of tiers on every
    /// call, see `MuiRemoteImage.body`'s `.task(id:)`).
    private var lastTiers: MuiRemoteImageTiers?

    public init(loader: @escaping @Sendable (URL) async throws -> Image) {
        self.loader = loader
    }

    /// Runs the whole `thumb -> preview -> full` sequence for `tiers`,
    /// publishing each tier as it resolves. A tier that fails is skipped,
    /// not fatal — only every tier failing flips `isError`. Always resets
    /// state first, so calling this again with a new `tiers` value (a
    /// reused view bound to a different image) restarts the state machine
    /// cleanly instead of showing a stale image or tier.
    public func start(tiers: MuiRemoteImageTiers) async {
        lastTiers = tiers
        image = nil
        tier = nil
        isLoading = true
        isError = false
        var loadedAny = false
        for (candidateTier, url) in tiers.ordered {
            guard !Task.isCancelled else { return }
            let loaded = try? await loader(url)
            // Re-check after the await: `.task(id:)` cancels the old task on
            // reuse, and a non-cooperatively-cancelled loader can still
            // return a value — publishing it would overwrite the newer
            // load's state with a stale tier.
            guard !Task.isCancelled else { return }
            guard let loaded else { continue }
            image = loaded
            tier = candidateTier
            isLoading = false
            loadedAny = true
        }
        guard !Task.isCancelled else { return }
        if !loadedAny {
            isError = true
            isLoading = false
        }
    }

    /// Re-runs the whole sequence from the top (remote-image.md §States,
    /// Error's Retry affordance).
    public func retry() async {
        guard let lastTiers else { return }
        await start(tiers: lastTiers)
    }
}

/// Loads an image whose bytes aren't available yet — fetches, decodes, and
/// displays whichever tier resolves first, then replaces it with a sharper
/// tier as better data arrives (remote-image.md §Purpose).
public struct MuiRemoteImage: View {
    public let tiers: MuiRemoteImageTiers
    public let alt: String
    public let fit: MuiImageFit

    @StateObject private var controller: MuiRemoteImageController

    public init(
        tiers: MuiRemoteImageTiers,
        alt: String,
        fit: MuiImageFit = .fill,
        loader: @escaping @Sendable (URL) async throws -> Image = MuiRemoteImage.defaultLoader
    ) {
        self.tiers = tiers
        self.alt = alt
        self.fit = fit
        self._controller = StateObject(wrappedValue: MuiRemoteImageController(loader: loader))
    }

    public var body: some View {
        ZStack {
            MuiTokens.imageCanvas

            if let image = controller.image {
                image
                    .resizable()
                    .aspectRatio(contentMode: fit == .fill ? .fill : .fit)
                    .blur(radius: blurRadius(for: controller.tier))
                    .animation(.easeOut(duration: 0.2), value: controller.tier)
            }

            if controller.isLoading && controller.image == nil {
                MuiSpinner(size: .md, placement: .centered)
            }

            if controller.isError {
                errorOverlay
            }
        }
        .clipped()
        // Bind the task's identity to the tier URLs, not just the view's
        // own identity: SwiftUI reuses this view (List cells, record
        // updates) with a fresh `tiers` value on the *same* `@StateObject`
        // controller, and a plain `.task { }` would never notice the
        // change (remote-image.md §States — this must not show the
        // previous cell's photo).
        .task(id: tiers.ordered.map(\.1)) { await controller.start(tiers: tiers) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(alt)
        .accessibilityAddTraits(.isImage)
    }

    private var errorOverlay: some View {
        VStack(spacing: MuiTokens.spacingSm) {
            MuiText("Couldn't load image", color: .muted)
            MuiButton(label: "Retry", variant: .secondary, size: .sm) {
                Task { await controller.retry() }
            }
        }
    }

    private func blurRadius(for tier: MuiRemoteImageTier?) -> CGFloat {
        switch tier {
        case .thumb: return 12
        case .preview: return 4
        case .full, .none: return 0
        }
    }

    /// The production loader: reads a local file URL straight off disk,
    /// otherwise fetches over the network. Showcase call sites must supply
    /// their own loader instead — the gallery never talks to the network.
    public static func defaultLoader(url: URL) async throws -> Image {
        if url.isFileURL {
            guard let image = await MuiPlatformImage.load(from: url) else {
                throw MuiRemoteImageError.decodeFailed
            }
            return image
        }
        let (data, _) = try await URLSession.shared.data(from: url)
        guard let image = MuiPlatformImage.decode(data) else {
            throw MuiRemoteImageError.decodeFailed
        }
        return image
    }
}

#Preview("MuiRemoteImage — Tiered load") {
    MuiRemoteImage(
        tiers: MuiRemoteImageTiers(thumb: URL(string: "demo://thumb"), full: URL(string: "demo://full")),
        alt: "Demo photo",
        loader: { url in
            try await Task.sleep(nanoseconds: url.absoluteString.contains("thumb") ? 50_000_000 : 400_000_000)
            return Image(systemName: "photo.fill")
        }
    )
    .frame(width: 160, height: 120)
    .background(MuiTokens.bg)
}

#Preview("MuiRemoteImage — Error + retry") {
    MuiRemoteImage(
        tiers: MuiRemoteImageTiers(full: URL(string: "demo://broken")),
        alt: "Broken demo photo",
        loader: { _ in throw MuiRemoteImageError.decodeFailed }
    )
    .frame(width: 160, height: 120)
    .background(MuiTokens.bg)
}
