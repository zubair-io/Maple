// Sources/MapleBackup/Reachability.swift
//
// Network status actor. Built on Network.framework's NWPathMonitor. The
// BackupEngine queries `status()` before sending bytes to decide whether
// to upload (Wi-Fi) or defer (cellular / offline).
//
// Returns `.wifi` for Wi-Fi/Ethernet/wired interfaces; `.cellular` for
// mobile; `.none` when the device is offline.
//
// The monitor's currentPath is read at init time to seed the initial
// status. Without this, the first status() call returns .none even on
// a connected device, which would incorrectly defer the first upload
// task until the first async path-update callback fires (~100ms later).
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
    private var current: Status

    public init() {
        self.monitor = NWPathMonitor()
        // Seed from currentPath immediately so status() returns the right
        // value on the first call rather than .none-by-default. NWPathMonitor's
        // first async update will overwrite this within a few hundred ms but
        // by then we'd have incorrectly deferred the first task on a Wi-Fi
        // device on cold launch.
        self.current = Self.classify(monitor.currentPath)
        self.monitor.pathUpdateHandler = { [weak self] path in
            Task { await self?.apply(path) }
        }
        self.monitor.start(queue: DispatchQueue.global(qos: .utility))
    }

    /// Snapshot the current state — non-blocking.
    public func status() -> Status { current }

    deinit { monitor.cancel() }

    private static func classify(_ path: NWPath) -> Status {
        if path.status != .satisfied { return .none }
        if path.usesInterfaceType(.cellular) { return .cellular }
        // .wifi, .wiredEthernet, .other (typically dev simulator) → .wifi
        return .wifi
    }

    private func apply(_ path: NWPath) {
        current = Self.classify(path)
    }
}
