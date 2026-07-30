// EditorAutoResetReachabilityTests.swift — #2244.
//
// RESET shipped under epic #1370 and its `EditorState` method stayed correct
// and fully tested throughout. What broke once was reachability: PR #1388 put
// the buttons in `EditorHeader.swift`, the canvas-first redesign (#1534 /
// #1555) superseded that view with `PillHeader.swift`, and commit e9454f62a
// deleted it — taking the only entry points with it. Every state-layer test
// kept passing because they all call the methods directly.
//
// So this one asserts the wiring instead of the behaviour: some view in the
// app target must invoke `resetToFactoryDefaults()`. Source-scanning is
// deliberate, and has precedent here (`MapleCloudKitPortabilityTests`) — the
// app target's SwiftUI views are not importable from the package's test
// bundle, and a real click test needs the XCUITest harness, which is
// fixture-gated and does not run in every `swift test`. This runs everywhere
// and fails the moment the last caller disappears again.
//
// AUTO was intentionally retired from the editor chrome when the pill nav was
// slimmed to always fit a phone screen: it, along with RESET, was removed from
// `PillHeader`. RESET keeps a home in `StackedAdjustmentsPanel` (iPad/Mac), so
// its reachability guard stays. `EditorState.applyAuto()` remains as tested
// state-layer API with no UI entry point, so there is no AUTO reachability
// assertion to keep here.

import XCTest

final class EditorAutoResetReachabilityTests: XCTestCase {

    /// `src/apple/Maple/Views`, resolved relative to this file so the walk
    /// does not depend on the working directory.
    private func viewsRoot() throws -> URL {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // MapleCore (package root)
            .deletingLastPathComponent()  // Packages
            .deletingLastPathComponent()  // apple
            .appendingPathComponent("Maple/Views")
        guard FileManager.default.fileExists(atPath: root.path) else {
            throw XCTSkip("app target sources not present next to the package — nothing to scan")
        }
        return root
    }

    /// Every `.swift` file under `src/apple/Maple/Views`, as source text.
    private func viewSources() throws -> [(name: String, text: String)] {
        let root = try viewsRoot()
        let walker = try XCTUnwrap(
            FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        let sources = try walker.compactMap { entry -> (name: String, text: String)? in
            guard let url = entry as? URL, url.pathExtension == "swift" else { return nil }
            return (url.lastPathComponent, try String(contentsOf: url, encoding: .utf8))
        }
        XCTAssertGreaterThan(sources.count, 20, "view sources not found — did the path walk break?")
        return sources
    }

    func testSomeEditorViewInvokesResetToFactoryDefaults() throws {
        let callers = try viewSources()
            .filter { $0.text.contains("resetToFactoryDefaults()") }
            .map(\.name)
        XCTAssertFalse(
            callers.isEmpty,
            "RESET is unreachable: no view under src/apple/Maple/Views calls "
            + "EditorState.resetToFactoryDefaults()."
        )
    }

    /// The RESET control must carry a VoiceOver label and a stable identifier
    /// wherever it lives — an unlabelled button is effectively unreachable for
    /// assistive tech and for UI tests.
    func testResetControlIsLabelled() throws {
        let sources = try viewSources()
        for token in ["\"Reset all adjustments\"", "\"editor-panel-reset-all\""] {
            let hosts = sources.filter { $0.text.contains(token) }.map(\.name)
            XCTAssertFalse(
                hosts.isEmpty,
                "No view under src/apple/Maple/Views carries \(token) — RESET must stay "
                + "labelled and addressable (web uses the same wording)."
            )
        }
    }
}
