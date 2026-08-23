// MuiDeviceList.swift — Maple UI Organisms · Configuration
// (unified-component-catalog.md §4.8). Paired devices (macOS, iOS, iPadOS,
// Windows clients) with revoke, built from List Row, Dialog, Empty State.
// Same confirmed-revoke shape as `MuiUserManagement`: the row's Revoke
// button only opens the dialog; `deviceRevoked` fires from its `confirmed`
// callback alone.

import SwiftUI

public struct MuiPairedDevice: Identifiable, Sendable {
    public let id: String
    public let name: String
    public let platform: String
    public let lastSeen: Date

    public init(id: String, name: String, platform: String, lastSeen: Date) {
        self.id = id
        self.name = name
        self.platform = platform
        self.lastSeen = lastSeen
    }
}

public struct MuiDeviceList: View {
    public let devices: [MuiPairedDevice]
    public let deviceRevoked: ((String) -> Void)?

    @State private var pendingRevoke: MuiPairedDevice?

    public init(devices: [MuiPairedDevice], deviceRevoked: ((String) -> Void)? = nil) {
        self.devices = devices
        self.deviceRevoked = deviceRevoked
    }

    public var body: some View {
        ZStack {
            if devices.isEmpty {
                MuiEmptyState(icon: "laptopcomputer.and.iphone", title: "No paired devices", message: "Pair a device from Settings → Devices.")
            } else {
                VStack(spacing: 0) {
                    ForEach(devices) { device in
                        MuiListRow(icon: Self.platformIcon(device.platform), label: device.name, timestampValue: device.lastSeen, trailing: {
                            MuiButton(label: "Revoke", variant: .ghost, size: .sm) { pendingRevoke = device }
                        })
                    }
                }
            }

            MuiDialog(
                isPresented: pendingRevoke != nil,
                title: "Revoke device?",
                message: pendingRevoke.map { "\($0.name) will be signed out and lose sync access." },
                confirmLabel: "Revoke",
                destructive: true,
                confirmed: { _ in confirmRevoke() },
                dismissed: { pendingRevoke = nil }
            )
        }
    }

    private func confirmRevoke() {
        guard let device = pendingRevoke else { return }
        deviceRevoked?(device.id)
        pendingRevoke = nil
    }

    static func platformIcon(_ platform: String) -> String {
        switch platform.lowercased() {
        case "macos": return "macbook"
        case "ios": return "iphone"
        case "ipados": return "ipad"
        case "windows": return "pc"
        default: return "desktopcomputer"
        }
    }
}

#Preview("MuiDeviceList") {
    MuiDeviceList(devices: [
        MuiPairedDevice(id: "1", name: "Zubair's MacBook Pro", platform: "macOS", lastSeen: Date().addingTimeInterval(-600)),
        MuiPairedDevice(id: "2", name: "iPhone 17 Pro", platform: "iOS", lastSeen: Date().addingTimeInterval(-7200)),
    ])
    .padding()
    .frame(width: 300)
    .background(MuiTokens.bg)
}

#Preview("MuiDeviceList — Empty") {
    MuiDeviceList(devices: [])
        .padding()
        .frame(width: 300)
        .background(MuiTokens.bg)
}
