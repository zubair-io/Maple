// PresetStore.swift — on-disk user presets + bundled built-ins (#1115).
//
// Storage per spec §10.7: JSON documents in Application Support, ONE FILE
// PER PRESET (`<id>.json` under `~/Library/Application Support/Maple/
// Presets/`), written atomically. Sync is a later phase — the per-file
// layout is what makes file-level sync tractable.
//
// Built-ins ship as the bundled `builtin-presets.json` resource — the
// SAME canonical file the web mirrors (parity-pinned by the API-side
// `builtin-presets-parity.test.ts`). They are read-only: no delete, no
// overwrite, and user presets can't take a built-in's name.
//
// Presets are user DATA. Nothing here touches original image files —
// applying a preset flows exclusively through `EditorState.applyPreset`
// → `EditSession.model` → the debounced XMP sidecar write.

import Foundation
import os

private let presetStoreLog = Logger(
    subsystem: "app.justmaple.aperture", category: "PresetStore"
)

// MARK: - Errors

public enum PresetStoreError: Error, Equatable, LocalizedError {
    case invalidName
    case emptyFields
    case duplicateName(String)
    case builtinName(String)
    case notFound
    case invalidID

    public var errorDescription: String? {
        switch self {
        case .invalidName:
            return "Preset names must be 1–\(Preset.nameMaxLength) printable characters."
        case .emptyFields:
            return "No edited settings to save — adjust something first."
        case .duplicateName(let name):
            return "A preset named “\(name)” already exists."
        case .builtinName(let name):
            return "“\(name)” is a built-in preset name."
        case .notFound:
            return "Preset not found."
        case .invalidID:
            return "Invalid preset id."
        }
    }
}

// MARK: - PresetStore

/// Actor-isolated disk I/O (per docs/best-practices.md § Swift). All
/// methods are small synchronous file operations under the actor.
public actor PresetStore {
    private let directory: URL

    /// - Parameter directory: storage root; defaults to
    ///   `Application Support/Maple/Presets`. Tests inject a temp dir.
    public init(directory: URL? = nil) {
        self.directory = directory ?? Self.defaultDirectory()
    }

    /// `~/Library/Application Support/Maple/Presets` (created lazily on
    /// first write). Falls back to a temporary directory if Application
    /// Support can't be resolved (effectively never on Apple platforms —
    /// sandboxed apps always have one) so the store stays functional for
    /// the session instead of trapping.
    private static func defaultDirectory() -> URL {
        let base = (try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: false
        )) ?? FileManager.default.temporaryDirectory
        return base
            .appendingPathComponent("Maple", isDirectory: true)
            .appendingPathComponent("Presets", isDirectory: true)
    }

    // MARK: List

    /// All user presets, name-sorted case-insensitively. Files that fail
    /// to decode — or whose `id` is unsafe or doesn't match the filename
    /// stem — are skipped (a corrupt document must not take down the whole
    /// list); they stay on disk untouched for manual recovery.
    public func list() throws -> [Preset] {
        let fm = FileManager.default
        guard fm.fileExists(atPath: directory.path) else { return [] }
        let urls = try fm.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil
        ).filter { $0.pathExtension.lowercased() == "json" }

        let decoder = JSONDecoder()
        var presets: [Preset] = []
        var skipped = 0
        for url in urls {
            guard let data = try? Data(contentsOf: url),
                  let preset = try? decoder.decode(Preset.self, from: data)
            else {
                skipped += 1
                continue
            }
            // The id is the load-bearing link back to the file: `delete(id:)`
            // resolves `<id>.json` from it, and SwiftUI `ForEach` requires
            // unique `Identifiable` ids. An unsafe id, or one that doesn't
            // match its filename stem (hand-edited or copied file), would
            // list fine but leave the real file undeletable — and a stem
            // mismatch can duplicate another document's id. Same treatment
            // as an undecodable file: skip it.
            guard Self.isSafeID(preset.id),
                  preset.id == url.deletingPathExtension().lastPathComponent
            else {
                skipped += 1
                continue
            }
            presets.append(preset)
        }
        if skipped > 0 {
            presetStoreLog.warning(
                "list: skipped \(skipped) corrupt preset file(s) (undecodable, unsafe id, or id ≠ filename stem) in \(self.directory.path, privacy: .public)"
            )
        }
        return presets.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    // MARK: Save

    /// Create a new user preset from already-captured sparse fields.
    /// Rejects invalid names, built-in name collisions, duplicates
    /// (case-insensitive), and empty field maps.
    @discardableResult
    public func save(name rawName: String, fields: [String: PresetFieldValue]) throws -> Preset {
        guard let name = Preset.normalizeName(rawName) else {
            throw PresetStoreError.invalidName
        }
        guard !fields.isEmpty else {
            throw PresetStoreError.emptyFields
        }
        if Self.builtins.contains(where: { $0.name.lowercased() == name.lowercased() }) {
            throw PresetStoreError.builtinName(name)
        }
        if try list().contains(where: { $0.name.lowercased() == name.lowercased() }) {
            throw PresetStoreError.duplicateName(name)
        }

        let preset = Preset(
            id: UUID().uuidString.lowercased(),
            schemaVersion: presetSchemaVersion,
            name: name,
            fields: fields
        )

        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(preset)
        try data.write(to: fileURL(for: preset.id), options: [.atomic])
        return preset
    }

    // MARK: Delete

    /// Delete a user preset by id. Built-ins never live in the directory,
    /// so they are undeletable by construction (callers also guard on
    /// `builtIn`).
    public func delete(id: String) throws {
        guard Self.isSafeID(id) else { throw PresetStoreError.invalidID }
        let url = fileURL(for: id)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw PresetStoreError.notFound
        }
        try FileManager.default.removeItem(at: url)
    }

    // MARK: Helpers

    private func fileURL(for id: String) -> URL {
        directory.appendingPathComponent("\(id).json", isDirectory: false)
    }

    /// IDs become filenames — restrict to the characters our own ids use
    /// (lowercase UUIDs) so a hostile id can't traverse out of the
    /// directory.
    private static func isSafeID(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 64 && id.allSatisfy {
            $0.isHexDigit || $0 == "-"
        }
    }

    // MARK: Built-ins

    /// Bundled, read-only utility presets — parsed once from the shared
    /// canonical JSON resource (`Resources/builtin-presets.json`, declared
    /// in Package.swift). The web compiles a mirror of the same file,
    /// drift-gated by the API-side parity test.
    public static let builtins: [Preset] = loadBuiltins()

    /// Shape of the bundled resource file.
    private struct BuiltinFile: Decodable {
        let schemaVersion: Int
        let presets: [Preset]
    }

    private static func loadBuiltins() -> [Preset] {
        guard let url = Bundle.module.url(forResource: "builtin-presets", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(BuiltinFile.self, from: data)
        else {
            // A missing/corrupt bundled resource is a build defect, not a
            // user state — fail loudly in development; production degrades
            // to an empty built-in section. `PresetTests` pins the count
            // so CI catches breakage.
            assertionFailure("builtin-presets.json missing or invalid in Bundle.module")
            return []
        }
        return file.presets.map { preset in
            var p = preset
            p.builtIn = true
            return p
        }
    }
}
