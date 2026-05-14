// Sources/MapleBackup/Reachability.swift
//
// Network status actor. Built on Network.framework's NWPathMonitor. The
// BackupEngine queries `status()` before sending bytes to decide whether
// to upload (Wi-Fi) or defer (cellular / offline).
//
// Returns `.wifi` for Wi-Fi/Ethernet/wired interfaces; `.cellular` for
// mobile; `.none` when the device is offline.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §13.

import Foundation
import Network

public actor Reachability {
    public enum Status: Sendable, Equatable {
        case wifi
        case cellular
        case none
    }

    private let monitor: NWPathMonitor
    private var current: Status = .none

    public init() {
        self.monitor = NWPathMonitor()
        self.monitor.pathUpdateHandler = { [weak self] path in
            Task { await self?.apply(path) }
        }
        self.monitor.start(queue: DispatchQueue.global(qos: .utility))
    }

    /// Snapshot the current state — non-blocking.
    public func status() -> Status { current }

    deinit { monitor.cancel() }

    private func apply(_ path: NWPath) {
        if path.status != .satisfied {
            current = .none
            return
        }
        if path.usesInterfaceType(.cellular) { current = .cellular; return }
        // .wifi, .wiredEthernet, .other (typically dev simulator) → .wifi
        current = .wifi
    }
}
