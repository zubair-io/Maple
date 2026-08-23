// OrganismsMapCommsConfigGalleryB.swift — Organisms §4.8 (Configuration),
// remaining five: Setup Wizard, User Management, Device List, Backup
// Monitor, Diagnostics. See OrganismsGallerySection.swift for the tab this
// feeds into, and OrganismsMapCommsConfigGalleryA.swift for Map,
// Communication, and the first two Configuration organisms.

import SwiftUI

struct OrganismsMapCommsConfigGalleryB: View {
    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            GallerySpecimenCard(name: "Setup Wizard", purpose: "Multi-step guided configuration", builtFrom: "Progress Step, Tabs, Form Field, Button") { SetupWizardDemo() }
            GallerySpecimenCard(name: "User Management", purpose: "Invite, list, and revoke access", builtFrom: "List Row, QR Code, Dialog, Form Field") { UserManagementDemo() }
            GallerySpecimenCard(name: "Device List", purpose: "Paired devices with revoke", builtFrom: "List Row, Dialog, Empty State") {
                HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
                    DeviceListDemo()
                    VStack(alignment: .leading, spacing: 2) {
                        MuiText("Empty", variant: .toolLabel, color: .muted)
                        MuiDeviceList(devices: [])
                            .frame(width: 160, height: 100)
                            .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
                    }
                }
            }
            GallerySpecimenCard(name: "Backup Monitor", purpose: "Configuration plus live progress", builtFrom: "Form Field, Progress, Banner") { BackupMonitorDemo() }
            GallerySpecimenCard(name: "Diagnostics", purpose: "Validation runs and raw output", builtFrom: "Button, Code Block, Badge") { DiagnosticsDemo() }
        }
    }
}

private struct SetupWizardDemo: View {
    @State private var stepIndex = 1
    var body: some View {
        MuiSetupWizard(steps: ["Server", "Storage", "Review"], stepIndex: $stepIndex) { index in
            switch index {
            case 0: MuiFormField(label: "Server host", value: .constant("maple.local"))
            case 1: MuiFormField(label: "Storage path", value: .constant("/volumes/photos"))
            default: MuiText("Ready to finish setup.", variant: .body, color: .muted)
            }
        }
        .frame(width: 340)
    }
}

private struct UserManagementDemo: View {
    @State private var invite = ""
    var body: some View {
        MuiUserManagement(
            users: [MuiManagedUser(id: "1", name: "Ada Lovelace", email: "ada@justmaple.app", role: "Admin")],
            inviteLink: "https://maple.local/invite/abc123", inviteValue: $invite
        )
        .frame(width: 300)
    }
}

private struct DeviceListDemo: View {
    var body: some View {
        MuiDeviceList(devices: [
            MuiPairedDevice(id: "1", name: "Zubair's MacBook Pro", platform: "macOS", lastSeen: Date().addingTimeInterval(-600)),
            MuiPairedDevice(id: "2", name: "iPhone 17 Pro", platform: "iOS", lastSeen: Date().addingTimeInterval(-7200)),
        ])
        .frame(width: 220, height: 100)
    }
}

private struct BackupMonitorDemo: View {
    @State private var destination = "/volumes/backups"
    @State private var schedule = "Nightly at 2am"
    var body: some View {
        MuiBackupMonitor(
            destinationPath: $destination, schedule: $schedule, running: true, progress: 62,
            lastResult: MuiBackupResult(message: "Last backup completed successfully.", variant: .success)
        )
        .frame(width: 300)
    }
}

private struct DiagnosticsDemo: View {
    var body: some View {
        MuiDiagnostics(
            checks: [
                MuiDiagnosticCheck(id: "1", label: "XMP sidecars readable", status: .pass),
                MuiDiagnosticCheck(id: "2", label: "GPU pipeline available", status: .fail),
            ],
            output: "gpu: no compatible adapter found"
        )
        .frame(width: 300)
    }
}
