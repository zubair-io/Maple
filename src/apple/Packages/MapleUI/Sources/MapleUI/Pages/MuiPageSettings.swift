// MuiPageSettings.swift — Maple UI Pages (unified-component-catalog.md
// §6). Settings Shell hosting Settings Section, Device List, and User
// Management — Maple Self Hosted's settings screen.
//
// The Shell's section nav decides which single organism the Pane shows —
// a direct switch over `activeSectionId`, the same "one nav id, one body"
// shape every Settings/Admin-style page in this catalog needs. The
// genuinely new wiring: revoking a device or a user, and sending an
// invite, are applied to this page's own arrays here — the organisms
// themselves only emit the event, per their own contracts.
// `MuiPageSettings.invited` is the pure reducer behind the invite path.

import SwiftUI

public enum MuiPageSettingsSectionId: String, CaseIterable, Identifiable, Sendable {
    case general, devices, users

    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .general: return "General"
        case .devices: return "Devices"
        case .users: return "Users"
        }
    }
    public var icon: String {
        switch self {
        case .general: return "gearshape"
        case .devices: return "laptopcomputer.and.iphone"
        case .users: return "person.2"
        }
    }
}

public struct MuiPageSettings: View {
    @State private var activeSectionId: MuiPageSettingsSectionId = .general
    @State private var storagePathValue = "/volumes/photos"
    @State private var devices: [MuiPairedDevice]
    @State private var users: [MuiManagedUser]
    @State private var inviteValue = ""

    public init(
        devices: [MuiPairedDevice] = MuiPageSettings.defaultDevices,
        users: [MuiManagedUser] = MuiPageSettings.defaultUsers
    ) {
        self._devices = State(initialValue: devices)
        self._users = State(initialValue: users)
    }

    public var body: some View {
        MuiSettingsShell {
            VStack(spacing: 0) {
                ForEach(MuiPageSettingsSectionId.allCases) { section in
                    MuiListRow(icon: section.icon, label: section.label, active: section.id == activeSectionId.id, pressed: { activeSectionId = section })
                }
            }
        } pane: {
            switch activeSectionId {
            case .general:
                MuiSettingsSection(
                    title: "General",
                    rows: [
                        .edit(MuiSettingsEditableRow(id: "storage", label: "Storage path", icon: "externaldrive", value: storagePathValue, help: "Where originals and sidecars are kept.")),
                        .navigate(MuiSettingsNavigableRow(id: "backups", label: "Backups", value: "Nightly", icon: "clock.arrow.circlepath")),
                    ],
                    banner: MuiSettingsSectionBanner(message: "Self Hosted is running on Bun + Elysia + MongoDB.", variant: .info),
                    fieldChanged: { _, value in storagePathValue = value }
                )
            case .devices:
                MuiDeviceList(devices: devices, deviceRevoked: { id in devices = devices.filter { $0.id != id } })
            case .users:
                MuiUserManagement(
                    users: users, inviteLink: "https://maple.local/invite/7xq2",
                    inviteValue: $inviteValue,
                    userInvited: { email in users = Self.invited(users, email: email) },
                    userRevoked: { id in users = users.filter { $0.id != id } }
                )
            }
        }
        .background(MuiTokens.bg)
    }

    // MARK: - Pure wiring logic (unit-testable without a live view)

    /// `users` with a newly invited member appended — a fabricated id/name
    /// derived from the invited email, "Member" role, matching what a
    /// pending invite looks like before the invitee accepts and sets a
    /// real name.
    public static func invited(_ users: [MuiManagedUser], email: String) -> [MuiManagedUser] {
        let nextId = "\((users.compactMap { Int($0.id) }.max() ?? users.count) + 1)"
        let name = email.split(separator: "@").first.map(String.init) ?? email
        return users + [MuiManagedUser(id: nextId, name: name, email: email, role: "Member")]
    }

    // MARK: - Default mock data

    public static let defaultDevices: [MuiPairedDevice] = [
        MuiPairedDevice(id: "1", name: "Zubair's MacBook Pro", platform: "macOS", lastSeen: Date().addingTimeInterval(-600)),
        MuiPairedDevice(id: "2", name: "iPhone 17 Pro", platform: "iOS", lastSeen: Date().addingTimeInterval(-7_200)),
    ]

    public static let defaultUsers: [MuiManagedUser] = [
        MuiManagedUser(id: "1", name: "Zubair Lawrence", email: "zubair@justmaple.app", role: "Admin"),
        MuiManagedUser(id: "2", name: "Ada Lovelace", email: "ada@justmaple.app", role: "Editor"),
    ]
}

#Preview("MuiPageSettings") {
    MuiPageSettings()
        .frame(width: 700, height: 460)
}
