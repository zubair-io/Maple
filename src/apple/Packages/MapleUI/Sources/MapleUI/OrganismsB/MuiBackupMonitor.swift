// MuiBackupMonitor.swift — Maple UI Organisms · Configuration
// (unified-component-catalog.md §4.8). Backup destination/schedule
// configuration plus a live run progress readout, built from Form Field,
// Progress, Banner, Button.

import SwiftUI

public enum MuiBackupResultVariant: Sendable {
    case success, error
}

public struct MuiBackupResult: Sendable {
    public let message: String
    public let variant: MuiBackupResultVariant

    public init(message: String, variant: MuiBackupResultVariant) {
        self.message = message
        self.variant = variant
    }
}

public struct MuiBackupMonitor: View {
    @Binding public var destinationPath: String
    @Binding public var schedule: String
    public let running: Bool
    public let progress: Double?
    public let lastResult: MuiBackupResult?
    public let configChanged: ((String, String) -> Void)?
    public let backupStartRequested: (() -> Void)?

    public init(
        destinationPath: Binding<String>,
        schedule: Binding<String>,
        running: Bool = false,
        progress: Double? = nil,
        lastResult: MuiBackupResult? = nil,
        configChanged: ((String, String) -> Void)? = nil,
        backupStartRequested: (() -> Void)? = nil
    ) {
        self._destinationPath = destinationPath
        self._schedule = schedule
        self.running = running
        self.progress = progress
        self.lastResult = lastResult
        self.configChanged = configChanged
        self.backupStartRequested = backupStartRequested
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            MuiFormField(label: "Destination", value: $destinationPath, placeholder: "/volumes/backups", onCommit: notifyConfigChanged)
            MuiFormField(label: "Schedule", value: $schedule, placeholder: "Nightly at 2am", onCommit: notifyConfigChanged)

            if running {
                MuiProgress(shape: .bar, value: progress, label: progress.map { "\(Int($0))%" } ?? "Enumerating files…")
            }

            if let lastResult {
                MuiBanner(variant: lastResult.variant == .success ? .success : .error, message: lastResult.message)
            }

            MuiButton(label: "Back Up Now", variant: .primary, isLoading: running, disabled: running) { backupStartRequested?() }
        }
    }

    private func notifyConfigChanged() {
        configChanged?(destinationPath, schedule)
    }
}

#Preview("MuiBackupMonitor") {
    struct Demo: View {
        @State private var destination = "/volumes/backups"
        @State private var schedule = "Nightly at 2am"
        var body: some View {
            MuiBackupMonitor(
                destinationPath: $destination, schedule: $schedule,
                running: true, progress: 62,
                lastResult: MuiBackupResult(message: "Last backup completed successfully.", variant: .success)
            )
            .padding()
            .frame(width: 320)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
