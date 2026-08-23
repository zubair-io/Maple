// MuiAvatarGroup.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.5; Built from: Avatar, Badge). Overlapping avatars with a "+N"
// overflow badge once the list exceeds `max`.

import SwiftUI

public struct MuiAvatarGroupMember: Identifiable, Sendable {
    public let id: String
    public let name: String
    public let url: URL?

    public init(id: String = UUID().uuidString, name: String, url: URL? = nil) {
        self.id = id
        self.name = name
        self.url = url
    }
}

public struct MuiAvatarGroup: View {
    public let avatars: [MuiAvatarGroupMember]
    public let max: Int
    public let size: MuiAvatarSize

    public init(avatars: [MuiAvatarGroupMember], max: Int = 3, size: MuiAvatarSize = .sm) {
        self.avatars = avatars
        self.max = max
        self.size = size
    }

    private var visible: [MuiAvatarGroupMember] { Array(avatars.prefix(max)) }
    private var overflowCount: Int { Swift.max(0, avatars.count - max) }

    public var body: some View {
        HStack(spacing: -overlap) {
            ForEach(visible) { member in
                MuiAvatar(name: member.name, url: member.url, size: size)
                    .overlay(Circle().stroke(MuiTokens.bg, lineWidth: 2))
            }
            if overflowCount > 0 {
                Circle()
                    .fill(MuiTokens.surfaceHover)
                    .frame(width: size.points, height: size.points)
                    .overlay(Circle().stroke(MuiTokens.bg, lineWidth: 2))
                    .overlay(
                        MuiText("+\(overflowCount)", variant: .chipLabel, color: .muted)
                    )
                    .accessibilityLabel("\(overflowCount) more")
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var overlap: CGFloat {
        size.points * 0.3
    }
}

#Preview("MuiAvatarGroup") {
    MuiAvatarGroup(avatars: [
        MuiAvatarGroupMember(name: "Ada Lovelace"),
        MuiAvatarGroupMember(name: "Grace Hopper"),
        MuiAvatarGroupMember(name: "Margaret Hamilton"),
        MuiAvatarGroupMember(name: "Katherine Johnson"),
        MuiAvatarGroupMember(name: "Radia Perlman"),
    ])
    .padding()
    .background(MuiTokens.bg)
}
