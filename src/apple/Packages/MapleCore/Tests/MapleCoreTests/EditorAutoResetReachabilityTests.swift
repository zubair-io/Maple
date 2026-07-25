// EditorAutoResetReachabilityTests.swift — #2244.
//
// AUTO and RESET shipped under epic #1370 and their `EditorState` methods
// stayed correct and fully tested throughout. What broke was reachability:
// PR #1388 put both buttons in `EditorHeader.swift`, the canvas-first
// redesign (#1534 / #1555) superseded that view with `PillHeader.swift`, and
// commit e9454f62a deleted it — taking the only entry points with it.
// `applyAuto()` then had zero call sites outside these tests, and every
// existing test still passed, because they all call the methods directly.
//
// So this one asserts the wiring instead of the behaviour: some view in the
// app target must invoke each method. Source-scanning is deliberate, and has
// precedent here (`MapleCloudKitPortabilityTests`) — the app target's SwiftUI
// views are not importable from the package's test bundle, and a real click
// test needs the XCUITest harness, which is fixture-gated and does not run in
// every `swift test`. This runs everywhere and fails the moment the last
// caller disappears again.

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

    func testSomeEditorViewInvokesApplyAuto() throws {
        let callers = try viewSources().filter { $0.text.contains("applyAuto()") }.map(\.name)
        XCTAssertFalse(
            callers.isEmpty,
            "AUTO is unreachable: no view under src/apple/Maple/Views calls EditorState.applyAuto(). "
            + "This is exactly how #2244 happened — the button's host view was deleted and every "
            + "state-layer test kept passing."
        )
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

    /// Both controls must carry a VoiceOver label and a stable identifier —
    /// the pill is icon/micro-type dense, so an unlabelled button is
    /// effectively unreachable for assistive tech and for UI tests.
    func testPillHeaderLabelsBothControls() throws {
        let pill = try XCTUnwrap(
            try viewSources().first { $0.name == "PillHeader.swift" },
            "PillHeader.swift not found")
        for token in [
            "\"Auto adjust\"", "\"editor-auto\"",
            "\"Reset all adjustments\"", "\"editor-reset-all\"",
        ] {
            XCTAssertTrue(
                pill.text.contains(token),
                "PillHeader.swift is missing \(token) — AUTO/RESET must stay labelled and "
                + "addressable (web uses the same wording)."
            )
        }
    }
}
