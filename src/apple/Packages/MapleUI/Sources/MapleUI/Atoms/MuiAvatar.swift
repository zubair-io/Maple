// MuiAvatar.swift — Maple UI Avatar atom.
// Contract: docs/design/maple-ui/components/avatar.md

import SwiftUI

public enum MuiAvatarSize: Sendable {
    case xs, sm, md, lg

    var points: CGFloat {
        switch self {
        case .xs: return 24
        case .sm: return 32
        case .md: return 40
        case .lg: return 56
        }
    }

    var fontSize: CGFloat {
        switch self {
        case .xs: return 10
        case .sm: return 12
        case .md: return 15
        case .lg: return 20
        }
    }

    var dotSize: CGFloat {
        switch self {
        case .xs, .sm: return 8
        case .md: return 10
        case .lg: return 14
        }
    }
}

public enum MuiAvatarPresence: Sendable {
    case online, offline
}

/// Represents a person — shows their photo when one is available,
/// otherwise their initials on a color derived from their name
/// (avatar.md §Purpose).
public struct MuiAvatar: View {
    public let name: String
    public let url: URL?
    public let size: MuiAvatarSize
    public let presence: MuiAvatarPresence?

    @State private var resolvedImage: Image?
    @State private var photoFailed = false

    public init(name: String, url: URL? = nil, size: MuiAvatarSize = .md, presence: MuiAvatarPresence? = nil) {
        self.name = name
        self.url = url
        self.size = size
        self.presence = presence
    }

    public var body: some View {
        ZStack(alignment: .bottomTrailing) {
            avatarBody
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(name)
                .accessibilityAddTraits(.isImage)

            if let presence {
                presenceDot(presence)
            }
        }
        .task(id: url) { await loadPhoto() }
    }

    @ViewBuilder
    private var avatarBody: some View {
        if let resolvedImage, !photoFailed {
            resolvedImage
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: size.points, height: size.points)
                .clipShape(Circle())
        } else {
            let palette = Self.paletteEntry(for: name)
            Circle()
                .fill(palette.background)
                .frame(width: size.points, height: size.points)
                .overlay(
                    Text(Self.initials(for: name))
                        .font(.system(size: size.fontSize, weight: .semibold))
                        .foregroundStyle(palette.foreground)
                )
        }
    }

    private func presenceDot(_ presence: MuiAvatarPresence) -> some View {
        Circle()
            .fill(presence == .online ? MuiTokens.successText : MuiTokens.textMuted)
            .frame(width: size.dotSize, height: size.dotSize)
            .overlay(Circle().stroke(MuiTokens.bg, lineWidth: 2))
            .accessibilityLabel(presence == .online ? "online" : "offline")
    }

    // A load failure falls back to initials exactly like having no `src`
    // at all — invisible to the caller, no error event to wire up
    // (avatar.md §States).
    private func loadPhoto() async {
        guard let url else {
            resolvedImage = nil
            photoFailed = false
            return
        }
        let image = await MuiPlatformImage.load(from: url)
        // A url change while this decode was in flight cancels the task
        // backing this call (`.task(id: url)`) and starts a fresh one for
        // the new url; skip applying this stale result so a cancelled
        // decode can't stomp the new load's state (mirrors MuiImage.load).
        guard !Task.isCancelled else { return }
        if let image {
            resolvedImage = image
            photoFailed = false
        } else {
            resolvedImage = nil
            photoFailed = true
        }
    }

    /// 1-2 letters from the first two words of `name`. Public + static for
    /// unit testing without rendering a view.
    public static func initials(for name: String) -> String {
        let words = name.split(separator: " ").filter { !$0.isEmpty }
        let letters = words.prefix(2).compactMap { $0.first }
        return String(letters).uppercased()
    }

    // Drawn entirely from existing tokens rather than inventing new hex
    // values (avatar.md §Tokens used).
    private static let palette: [(background: Color, foreground: Color)] = [
        (MuiTokens.primary, MuiTokens.textMain),
        (MuiTokens.primaryDim, MuiTokens.textMain),
        (MuiTokens.surfaceHover, MuiTokens.textMain),
        (MuiTokens.warn, MuiTokens.bg),
        (MuiTokens.borderHi, MuiTokens.textMain),
    ]

    static func paletteEntry(for name: String) -> (background: Color, foreground: Color) {
        palette[paletteIndex(for: name)]
    }

    /// A deterministic djb2-style hash over `name`'s UTF-8 bytes — stable
    /// across runs and processes, unlike Swift's default `Hashable` (seeded
    /// per-process), so the same person gets the same color every time the
    /// app loads and tests can assert on it directly (avatar.md
    /// §Accessibility: "no randomness, no Date.now()").
    public static func paletteIndex(for name: String) -> Int {
        var hash: UInt64 = 5381
        for byte in name.utf8 {
            hash = ((hash << 5) &+ hash) &+ UInt64(byte)
        }
        return Int(hash % UInt64(palette.count))
    }
}

#Preview("MuiAvatar — Sizes") {
    HStack(alignment: .bottom, spacing: 12) {
        MuiAvatar(name: "Jane Doe", size: .xs)
        MuiAvatar(name: "Jane Doe", size: .sm)
        MuiAvatar(name: "Jane Doe", size: .md)
        MuiAvatar(name: "Jane Doe", size: .lg)
    }
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiAvatar — Presence + fallback palette") {
    HStack(spacing: 12) {
        MuiAvatar(name: "Ada Lovelace", presence: .online)
        MuiAvatar(name: "Grace Hopper", presence: .offline)
        MuiAvatar(name: "Margaret Hamilton")
        MuiAvatar(name: "Katherine Johnson")
    }
    .padding()
    .background(MuiTokens.bg)
}
