// AddCloudSheetTarget.swift — Identifiable backing value for the
// AddMapleCloud sheet (presented via `.sheet(item:)`). Extracted from
// AppShell.swift as part of the multi-PR AppShell split (#123, slice 1).

import Foundation

// MARK: - AddMapleCloud sheet target

/// Backing value for `.sheet(item:)` so dismissal automatically resets to
/// `nil`. Two cases mirror the two entry points: a fresh "+" tap and a
/// click on a saved server whose tokens were cleared.
enum AddCloudSheetTarget: Identifiable, Equatable {
    case fresh
    case prefilled(String)

    var id: String {
        switch self {
        case .fresh: return ""
        case .prefilled(let host): return host
        }
    }

    var prefill: String {
        switch self {
        case .fresh: return ""
        case .prefilled(let host): return host
        }
    }
}

// MARK: - Pending cloud reopen (#1381)

/// A cloud folder the user was trying to open when an auth error forced a
/// re-sign-in. Stashed so the sign-in sheet's success handler can replay the
/// load and land the user on their photos instead of the error screen.
struct PendingCloudOpen: Equatable {
    let serverID: URL
    let folderID: String
    let libraryPath: String
}
