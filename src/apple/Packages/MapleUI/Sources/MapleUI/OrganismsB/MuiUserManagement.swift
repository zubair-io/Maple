// MuiUserManagement.swift — Maple UI Organisms · Configuration
// (unified-component-catalog.md §4.8). Invite, list, and revoke access for
// a Self Hosted deployment's users, built from List Row, QR Code, Dialog,
// Form Field.
//
// Revoke is a two-step, confirmed action: pressing a row's Revoke button
// only opens the confirm `MuiDialog` (tracking the target user in local
// state) — `userRevoked` fires from the dialog's own `confirmed` callback,
// never from the row press directly.

import SwiftUI

public struct MuiManagedUser: Identifiable, Sendable {
    public let id: String
    public let name: String
    public let email: String
    public let role: String

    public init(id: String, name: String, email: String, role: String) {
        self.id = id
        self.name = name
        self.email = email
        self.role = role
    }
}

public struct MuiUserManagement: View {
    public let users: [MuiManagedUser]
    public let inviteLink: String
    @Binding public var inviteValue: String
    public let userInvited: ((String) -> Void)?
    public let userRevoked: ((String) -> Void)?

    @State private var pendingRevoke: MuiManagedUser?

    public init(
        users: [MuiManagedUser],
        inviteLink: String = "",
        inviteValue: Binding<String>,
        userInvited: ((String) -> Void)? = nil,
        userRevoked: ((String) -> Void)? = nil
    ) {
        self.users = users
        self.inviteLink = inviteLink
        self._inviteValue = inviteValue
        self.userInvited = userInvited
        self.userRevoked = userRevoked
    }

    public var body: some View {
        ZStack {
            VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
                if !inviteLink.isEmpty {
                    HStack(alignment: .top, spacing: MuiTokens.spacingMd) {
                        MuiQrCode(value: inviteLink, size: .sm)
                        VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                            MuiFormField(label: "Invite by email", value: $inviteValue, placeholder: "name@example.com", onCommit: commitInvite)
                            MuiButton(label: "Send invite", variant: .primary, size: .sm) { commitInvite() }
                        }
                    }
                }

                VStack(spacing: 0) {
                    ForEach(users) { user in
                        MuiListRow(icon: "person.crop.circle", label: user.name, subtitle: "\(user.email) · \(user.role)", trailing: {
                            MuiButton(label: "Revoke", variant: .ghost, size: .sm) { pendingRevoke = user }
                        })
                    }
                }
            }

            MuiDialog(
                isPresented: pendingRevoke != nil,
                title: "Revoke access?",
                message: pendingRevoke.map { "\($0.name) (\($0.email)) will lose access immediately." },
                confirmLabel: "Revoke",
                destructive: true,
                confirmed: { _ in confirmRevoke() },
                dismissed: { pendingRevoke = nil }
            )
        }
    }

    private func commitInvite() {
        let trimmed = inviteValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        userInvited?(trimmed)
        inviteValue = ""
    }

    private func confirmRevoke() {
        guard let user = pendingRevoke else { return }
        userRevoked?(user.id)
        pendingRevoke = nil
    }
}

#Preview("MuiUserManagement") {
    struct Demo: View {
        @State private var invite = ""
        var body: some View {
            MuiUserManagement(
                users: [MuiManagedUser(id: "1", name: "Ada Lovelace", email: "ada@justmaple.app", role: "Admin")],
                inviteLink: "https://maple.local/invite/abc123",
                inviteValue: $invite
            )
            .padding()
            .frame(width: 340)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
