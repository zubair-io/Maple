// RelocateParityTests.swift — cross-surface file-operation outcome-parity
// harness (#2633), Swift runner.
//
// Replays the declarative corpus at
// `test-fixtures/file-operations/cases.json` against THIS module's own
// primitives (`LocalFileOperations.relocate`, `FilenameValidation.
// isValidFolderName`, `LocalFileOperations.renameFolder`). The Bun runner
// (`src/api/src/fs/relocate.parity.test.ts`) and the Windows runner
// (`src/windows/Maple.WinUI.Tests/RelocateParityTests.cs`) replay the SAME
// corpus against their own primitives — proving identical OUTCOMES without
// sharing code, the same philosophy as the XMP golden-file corpus.
//
// One XCTest method drives the whole corpus (Swift/XCTest has no built-in
// dynamic-test-per-JSON-case facility short of code generation) so a single
// run reports every case; failures accumulate via `XCTFail` per case rather
// than stopping at the first one, so one run shows every divergence. A case
// whose `requires` capability isn't available (probed live) or whose
// `platforms` excludes `"apple"` is skipped with an explicit line to stderr
// naming the case and the reason — never silently omitted.

import XCTest
@testable import MapleCore

// MARK: - Corpus schema

private struct CorpusFile: Codable, Equatable {
    let path: String
    let content: String
}
private struct CorpusSymlink: Codable {
    let path: String
    let target: String
}
private struct CorpusSetup: Codable {
    let files: [CorpusFile]?
    let symlinks: [CorpusSymlink]?
}
private struct CorpusFault: Codable {
    let type: String
}
private struct CorpusOperation: Codable {
    let source: String?
    let destDir: String?
    let destBasename: String?
    let mode: String?
    let collision: String?
    let fault: CorpusFault?
    let folderPath: String?
    let newName: String?
    let name: String?
}
private struct CorpusExpected: Codable {
    let outcome: String?
    let renamedOnCollision: Bool?
    let sidecarFollowed: Bool?
    let tree: [CorpusFile]?
    let valid: Bool?
    let selectedIndex: Int?
}
private struct CorpusCase: Codable {
    let name: String
    let kind: String
    let description: String
    let platforms: [String]?
    let requires: [String]
    let setup: CorpusSetup?
    let operation: CorpusOperation?
    let expected: CorpusExpected
}
private struct Corpus: Codable {
    let schema_version: Int
    let cases: [CorpusCase]
}

private let expectedSchemaVersion = 1

/// Known Swift-side divergences the corpus caught, filed, and left as an
/// EXPECTED failure (never silently green, never silently skipped) — mirrors
/// the Bun runner's `KNOWN_FAILURES`. Empty today: the delete-before-copy
/// replace-mode bug and the missing `newBasename` traversal guard the
/// harness's first run surfaced were both small, obviously-correct fixes
/// landed directly in `LocalFileOperations.swift` rather than filed.
private let knownFailures: [String: String] = [:]

private func stderrLine(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

final class RelocateParityTests: XCTestCase {

    private func findRepoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let fm = FileManager.default
        while true {
            if fm.fileExists(atPath: dir.appendingPathComponent("CLAUDE.md").path),
               fm.fileExists(atPath: dir.appendingPathComponent("src").path) {
                return dir
            }
            let parent = dir.deletingLastPathComponent()
            guard parent.path != dir.path else {
                throw XCTSkip("RelocateParityTests: could not locate repo root from \(#filePath)")
            }
            dir = parent
        }
    }

    private func loadCorpus() throws -> Corpus {
        let root = try findRepoRoot()
        let corpusURL = root.appendingPathComponent("test-fixtures/file-operations/cases.json")
        guard FileManager.default.fileExists(atPath: corpusURL.path) else {
            throw XCTSkip("RelocateParityTests: corpus not found at \(corpusURL.path)")
        }
        let data = try Data(contentsOf: corpusURL)
        let corpus = try JSONDecoder().decode(Corpus.self, from: data)
        guard corpus.schema_version == expectedSchemaVersion else {
            XCTFail(
                "RelocateParityTests: cases.json schema_version \(corpus.schema_version) != expected "
                + "\(expectedSchemaVersion) — the runner and the corpus have drifted apart")
            throw XCTSkip("schema_version mismatch")
        }
        return corpus
    }

    // MARK: - Capability probes

    private func probeCaseInsensitiveFS(in dir: URL) -> Bool {
        let fm = FileManager.default
        let probe = dir.appendingPathComponent("case-probe-a-\(UUID().uuidString)")
        try? "x".write(to: probe, atomically: true, encoding: .utf8)
        defer { try? fm.removeItem(at: probe) }
        let upper = URL(fileURLWithPath: probe.path.replacingOccurrences(of: "case-probe-a-", with: "CASE-PROBE-A-"))
        return fm.fileExists(atPath: upper.path)
    }

    private func requiresReason(_ requires: [String], root: URL) -> String? {
        for cap in requires {
            switch cap {
            case "symlinks", "posix-permissions":
                continue // always available on macOS
            case "case-insensitive-fs":
                if !probeCaseInsensitiveFS(in: root) {
                    return "case-insensitive-fs: temp volume is case-sensitive"
                }
            case "multi-location-fileinfo":
                return "multi-location-fileinfo: Apple local sources are single-location by construction"
            default:
                return "unknown capability \"\(cap)\""
            }
        }
        return nil
    }

    // MARK: - Filesystem helpers

    private func writeFile(_ root: URL, _ rel: String, _ content: String) throws {
        let target = rel.split(separator: "/").reduce(root) { $0.appendingPathComponent(String($1)) }
        try FileManager.default.createDirectory(
            at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try content.write(to: target, atomically: true, encoding: .utf8)
    }

    private func absURL(_ root: URL, _ rel: String) -> URL {
        rel.isEmpty ? root : rel.split(separator: "/").reduce(root) { $0.appendingPathComponent(String($1)) }
    }

    /// Every regular file under `root`, as POSIX-relative paths with
    /// content — exhaustive, matching the Bun runner's `readTree`, with two
    /// exclusions: a leaked `.tmp.` publish artifact (its own distinct bug,
    /// not what this harness targets), and anything under `.maple/` — the
    /// on-disk LibraryIndex cache `LocalFileOperations` writes as a
    /// same-process side effect of a relocate (`LocalFileOperations+
    /// CacheAndIndex.swift`). That index is Apple-only (TS/C# have no
    /// on-disk mirror of it) and explicitly NOT part of the relocate
    /// CONTRACT this corpus proves — docs/caching.md is clear the cache is
    /// derived and disposable, so it must not make an otherwise-identical
    /// outcome look like a cross-platform divergence.
    private func readTree(_ root: URL) throws -> [CorpusFile] {
        var out: [CorpusFile] = []
        let fm = FileManager.default
        // `temporaryDirectory` is reachable through a `/private` symlink on
        // macOS (`/var` -> `/private/var`), and `FileManager.enumerator`
        // does not consistently resolve that the same way `root` itself
        // does — a plain string-prefix strip is fragile here. Comparing
        // STANDARDIZED PATH COMPONENTS instead sidesteps the symlink
        // question entirely: whatever form each side resolves to, the
        // relative tail is just "however many components longer than
        // root's own component count."
        let resolvedRoot = root.resolvingSymlinksInPath().standardizedFileURL
        let rootComponents = resolvedRoot.pathComponents
        guard let enumerator = fm.enumerator(at: resolvedRoot, includingPropertiesForKeys: [.isRegularFileKey]) else {
            return []
        }
        for case let url as URL in enumerator {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey])
            guard values.isRegularFile == true, !url.lastPathComponent.contains(".tmp.") else { continue }
            let standardized = url.resolvingSymlinksInPath().standardizedFileURL
            let relComponents = Array(standardized.pathComponents.dropFirst(rootComponents.count))
            // `.maple/` can appear at ANY depth — the crash-window case's
            // fault directory is "src/IMG_1.CR3" while the destination
            // "Album/.maple/index.json" is nested one level in, so this
            // must check the whole path, not just its first component.
            guard !relComponents.contains(".maple") else { continue }
            let rel = relComponents.joined(separator: "/")
            let content = (try? String(contentsOf: url, encoding: .utf8)) ?? "<binary>"
            out.append(CorpusFile(path: rel, content: content))
        }
        return out.sorted { $0.path < $1.path }
    }

    private func assertTree(_ actual: [CorpusFile], _ expected: [CorpusFile]?, _ label: String) {
        guard let expected else { return }
        XCTAssertEqual(
            actual.sorted { $0.path < $1.path },
            expected.sorted { $0.path < $1.path },
            "\(label): resulting file tree")
    }

    // MARK: - Per-kind execution

    private func runRelocateCase(_ c: CorpusCase) async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("relocate-parity-\(UUID().uuidString)")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        var chmodBack: [URL] = []
        defer {
            for dir in chmodBack {
                try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path)
            }
            try? fm.removeItem(at: root)
        }

        for f in c.setup?.files ?? [] { try writeFile(root, f.path, f.content) }
        for link in c.setup?.symlinks ?? [] {
            try fm.createSymbolicLink(at: absURL(root, link.path), withDestinationURL: absURL(root, link.target))
        }

        let op = c.operation!
        let sourceURL = absURL(root, op.source!)
        let destDirURL = absURL(root, op.destDir ?? "")
        let mode: RelocateMode = op.mode == "copy" ? .copy : .move

        let collision: CollisionPolicy
        switch op.collision {
        case "auto-suffix": collision = .autoSuffix
        case "replace": collision = .replace
        case "fail": collision = .fail
        case "skip", "keep-both":
            // Neither exists in Swift's CollisionPolicy (autoSuffix|fail|
            // replace) — every corpus case using these already restricts
            // `platforms` to exclude "apple" (see the corpus's own
            // divergence note). Reaching this means the corpus and this
            // runner have drifted apart.
            XCTFail("\(c.name): collision \"\(op.collision ?? "")\" has no Swift CollisionPolicy equivalent and should have been platform-excluded")
            return
        default:
            XCTFail("\(c.name): unknown collision policy \"\(op.collision ?? "")\"")
            return
        }

        if op.fault?.type == "readonly-source-dir" {
            let sourceDirURL = sourceURL.deletingLastPathComponent()
            try fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: sourceDirURL.path)
            chmodBack.append(sourceDirURL)
        }

        var outcome: RelocateOutcome?
        var thrown: Error?
        do {
            outcome = try await LocalFileOperations.relocate(
                sourceURL, to: destDirURL, newBasename: op.destBasename, mode: mode, collision: collision)
        } catch {
            thrown = error
        }

        // Swift's primitive has no `'skipped'` outcome shape (only Bun's
        // `CollisionPolicy.skip` produces that) — a corpus case expecting
        // "skipped" is always platform-excluded from "apple".
        let actualOutcome = thrown != nil ? "error" : "relocated"
        XCTAssertEqual(actualOutcome, c.expected.outcome, "\(c.name): outcome (thrown: \(String(describing: thrown)))")

        if let outcome, thrown == nil {
            if let expectedRenamed = c.expected.renamedOnCollision {
                XCTAssertEqual(outcome.renamedDueToCollision, expectedRenamed, "\(c.name): renamedOnCollision")
            }
            if let expectedSidecar = c.expected.sidecarFollowed {
                XCTAssertEqual(outcome.sidecarFollowed, expectedSidecar, "\(c.name): sidecarFollowed")
            }
        }

        assertTree(try readTree(root), c.expected.tree, c.name)
    }

    private func runNameValidationCase(_ c: CorpusCase) {
        let name = c.operation!.name!
        XCTAssertEqual(
            FilenameValidation.isValidFolderName(name), c.expected.valid,
            "\(c.name): FilenameValidation.isValidFolderName(\"\(name)\")")
    }

    private func runFolderRenameCase(_ c: CorpusCase) throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("relocate-parity-folder-\(UUID().uuidString)")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }

        for f in c.setup?.files ?? [] { try writeFile(root, f.path, f.content) }

        let op = c.operation!
        let folderURL = absURL(root, op.folderPath!)
        do {
            _ = try LocalFileOperations.renameFolder(folderURL, to: op.newName!)
            XCTAssertEqual("relocated", c.expected.outcome, "\(c.name): outcome")
        } catch {
            XCTAssertEqual("error", c.expected.outcome, "\(c.name): outcome (threw \(error))")
        }

        assertTree(try readTree(root), c.expected.tree, c.name)
    }

    // MARK: - Driver

    func testCorpusParity() async throws {
        let corpus = try loadCorpus()
        print("RelocateParityTests: loaded \(corpus.cases.count) cases")
        let probeRoot = FileManager.default.temporaryDirectory

        for c in corpus.cases {
            if let platforms = c.platforms, !platforms.contains("apple") {
                stderrLine("SKIP \(c.name): platforms=\(platforms) excludes \"apple\"")
                continue
            }
            if let reason = requiresReason(c.requires, root: probeRoot) {
                stderrLine("SKIP \(c.name): missing capability — \(reason)")
                continue
            }
            if let known = knownFailures[c.name] {
                stderrLine("KNOWN FAILURE \(c.name): \(known)")
                continue
            }

            do {
                switch c.kind {
                case "relocate":
                    try await runRelocateCase(c)
                case "name-validation":
                    runNameValidationCase(c)
                case "folder-rename":
                    try runFolderRenameCase(c)
                case "selector":
                    stderrLine("SKIP \(c.name): kind \"selector\" is API-only (multi-location-fileinfo)")
                default:
                    XCTFail("\(c.name): unknown corpus case kind \"\(c.kind)\"")
                }
            } catch {
                XCTFail("\(c.name): threw \(error)")
            }
        }
    }
}
