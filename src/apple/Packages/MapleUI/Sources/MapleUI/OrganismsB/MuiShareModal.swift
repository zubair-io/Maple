// MuiShareModal.swift — Maple UI Organisms · Modals (unified-component-
// catalog.md §4.4). Manage who has access to a shared item, built on
// Overlay Shell from Avatar Group, Form Field, List Row.

import SwiftUI

public struct MuiShareMember: Identifiable, Sendable {
    public let id: String
    public let name: String
    public let role: String
    public let avatarUrl: URL?

    public init(id: String, name: String, role: String, avatarUrl: URL? = nil) {
        self.id = id
        self.name = name
        self.role = role
        self.avatarUrl = avatarUrl
    }
}

public struct MuiShareModal: View {
    public let isPresented: Bool
    public let contained: Bool
    public let members: [MuiShareMember]
    @Binding public var inviteValue: String
    public let memberInvited: ((String) -> Void)?
    public let memberRemoved: ((String) -> Void)?
    public let dismissed: (() -> Void)?

    public init(
        isPresented: Bool,
        contained: Bool = false,
        members: [MuiShareMember],
        inviteValue: Binding<String>,
        memberInvited: ((String) -> Void)? = nil,
        memberRemoved: ((String) -> Void)? = nil,
        dismissed: (() -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.contained = contained
        self.members = members
        self._inviteValue = inviteValue
        self.memberInvited = memberInvited
        self.memberRemoved = memberRemoved
        self.dismissed = dismissed
    }

    public var body: some View {
        MuiOverlayShell(isPresented: isPresented, accessibilityLabel: "Share", contained: contained) {
            MuiText("Share", variant: .sheetTitle)
        } content: {
            VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
                MuiAvatarGroup(avatars: members.map { MuiAvatarGroupMember(id: $0.id, name: $0.name, url: $0.avatarUrl) })

                HStack {
                    MuiFormField(label: "Invite", value: $inviteValue, placeholder: "name@example.com", onCommit: invite)
                    MuiButton(label: "Invite", variant: .primary, size: .sm, disabled: !canInvite) { invite() }
                        .padding(.top, 20)
                }

                VStack(spacing: 0) {
                    ForEach(members) { member in
                        MuiListRow(icon: "person.crop.circle", label: member.name, subtitle: member.role, trailing: {
                            MuiButton(label: "Remove", variant: .ghost, size: .sm) { memberRemoved?(member.id) }
                        })
                    }
                }
            }
        } footer: {
            HStack {
                Spacer()
                MuiButton(label: "Done", variant: .primary) { dismissed?() }
            }
        } dismissed: {
            dismissed?()
        }
    }

    private var canInvite: Bool {
        !inviteValue.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func invite() {
        let trimmed = inviteValue.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        memberInvited?(trimmed)
        inviteValue = ""
    }
}

#Preview("MuiShareModal") {
    struct Demo: View {
        @State private var open = false
        @State private var invite = ""
        var body: some View {
            ZStack {
                MuiTokens.bg
                MuiButton(label: "Open Share", variant: .primary) { open = true }
                MuiShareModal(
                    isPresented: open,
                    members: [MuiShareMember(id: "1", name: "Ada Lovelace", role: "Editor")],
                    inviteValue: $invite,
                    dismissed: { open = false }
                )
            }
            .frame(width: 380, height: 340)
        }
    }
    return Demo()
}
