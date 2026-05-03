// SourceSelection.swift — lightweight enum describing which kind of
// ImageSource the user has selected in the sidebar, plus UserDefaults glue
// so the app re-opens to the last-used source.
//
// Passwords + security-scoped bookmarks live in their own stores
// (Keychain for SMB / SelfHosted; the FilesystemSource bookmark helper for
// file folders). This type stores only the identifying token: a URL, an
// SMB share tuple, or a PhotoKit flag.

import Foundation

// MARK: - SourceSelection

public enum SourceSelection: Sendable, Equatable, Codable {
    case filesystem(bookmark: Data)
    case photoKit
    case photoKitFilter(PhotoKitFilter)
    case smb(SMBCredentialStore.SavedShare)
    case selfHosted(baseURL: URL)
}

// MARK: - SourceSelectionStore

/// Persists the last-used source so the app reopens where the user left off.
/// This is a static facade over `UserDefaults`; there's no in-memory state.
public enum SourceSelectionStore {
    private static let key = "app.justmaple.aperture.lastSource"

    public static func load() -> SourceSelection? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(SourceSelection.self, from: data)
    }

    public static func save(_ selection: SourceSelection) {
        guard let data = try? JSONEncoder().encode(selection) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    public static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}
