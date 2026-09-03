// EditSessionTransactionTests — the committed-action contract (#2432):
// every action class produces exactly one undo entry with a valid redo
// path, a no-op produces none, the sidecar round-trips the committed state
// through a REAL .xmp file, a stale render cannot clobber a newer
// transaction, and assistive technology hears the committed change.

import XCTest

@testable import MapleCore

/// Records what the session announced, in order.
final class RecordingAnnouncer: EditAnnouncer, @unchecked Sendable {
    private let lock = NSLock()
    private var _texts: [String] = []
    var texts: [String] {
        lock.lock(); defer { lock.unlock() }
        return _texts
    }
    func announce(_ text: String) {
        lock.lock(); defer { lock.unlock() }
        _texts.append(text)
    }
}

@MainActor
final class EditSessionTransactionTests: XCTestCase {
    /// The committed synthetic grey DNG (`src/apple/MapleUITests/Fixtures/
    /// synthetic/`) — a real, decodable RAW, small enough to develop in a
    /// unit test.
    private static let syntheticDNG: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }  // → src/apple
        return url.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
    }()

    private func makeSession(announcer: RecordingAnnouncer = RecordingAnnouncer()) -> EditSession {
        let session = EditSession(
            asset: AssetRef(displayName: "t.dng", hintExtension: "dng") { Data() },
            model: .default, culling: CullingState())
        session.announcer = announcer
        return session
    }

    /// Copies the synthetic DNG into a fresh temp directory so a real
    /// `XMPSidecarStore` writes a real `.xmp` beside it.
    private func makeFileBackedSession(announcer: RecordingAnnouncer = RecordingAnnouncer()) throws -> (EditSession, URL) {
        let dir = try SidecarContractIO.makeTempDirectory(prefix: "edit-transaction")
        let raw = dir.appendingPathComponent("grey.dng")
        try FileManager.default.copyItem(at: Self.syntheticDNG, to: raw)
        let session = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
        session.announcer = announcer
        return (session, raw)
    }

    // MARK: - One entry per action class, valid redo path

    /// action → undo → redo → compare, per action class. Each closure
    /// performs ONE user action through the same entry point the UI uses.
    func testEveryActionClassIsExactlyOneUndoEntryWithAValidRedoPath() async throws {
        let (fileSession, _) = try makeFileBackedSession()
        let preset = Preset(id: "p", name: "Punchy", fields: ["contrast": .number(25), "saturation": .number(10)])
        let actions: [(String, EditTransaction.Kind, (EditorState) async -> Void)] = [
            ("slider drag", .adjustment, { state in
                state.arm(tool: .exposure)
                state.commit()
                state.beginGesture()
                state.setArmedDisplayValue(0.25)
                state.setArmedDisplayValue(0.5)
                state.setArmedDisplayValue(0.75)
                state.endGesture()
            }),
            ("reset armed tool", .reset, { state in
                state.arm(tool: .exposure)
                state.resetArmedTool()
            }),
            ("reset group", .reset, { state in state.resetGroup(.light) }),
            ("preset", .preset, { state in _ = state.applyPreset(preset) }),
            ("black & white", .adjustment, { state in state.setBlackWhite(.on) }),
            ("reset all", .reset, { state in state.resetToFactoryDefaults() }),
            ("auto", .auto, { state in
                state.autoProvider = { _ in
                    AutoAdjustmentsResult(
                        exposure: 0.8, temperature: 5000, tint: 0,
                        contrast: 5, highlights: -10, shadows: 10, whites: -3, blacks: -4)
                }
                await state.applyAuto()
            }),
            ("crop", .crop, { state in
                state.commit(kind: .crop, description: "Crop")
                state.session.model.crop = Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9)
                state.session.endEdit()
            }),
            ("paste", .paste, { state in
                var source = AdjustmentModel.default
                source.vibrance = 33
                _ = await AdjustmentPasteApplier.apply(
                    source: source, groups: [.color],
                    to: [state.session.asset], sessions: [state.session.asset.id: state.session])
            }),
        ]
        for (label, kind, act) in actions {
            let state = EditorState(session: fileSession)
            // Seed a non-default model so every reset has something to undo.
            fileSession.beginEdit(description: "seed")
            fileSession.model.exposure = 1.5
            fileSession.model.contrast = 40
            fileSession.model.saturation = -20
            fileSession.endEdit()
            let before = fileSession.model
            let entries = fileSession.undoHistory.count

            await act(state)

            let after = fileSession.model
            XCTAssertNotEqual(before, after, "\(label): the action changed nothing")
            XCTAssertEqual(fileSession.undoHistory.count, entries + 1, "\(label): exactly one undo entry")
            let tx = try XCTUnwrap(fileSession.lastCommittedTransaction, label)
            XCTAssertEqual(tx.kind, kind, label)
            XCTAssertEqual(tx.before, before, label)
            XCTAssertEqual(tx.after, after, label)
            XCTAssertFalse(tx.diff.isEmpty, label)

            state.undo()
            XCTAssertEqual(fileSession.model, before, "\(label): undo restores before")
            XCTAssertTrue(fileSession.canRedo, label)
            state.redo()
            XCTAssertEqual(fileSession.model, after, "\(label): redo restores after")
            XCTAssertEqual(fileSession.undoHistory.count, entries + 1, "\(label): redo re-records one entry")
        }
    }

    // MARK: - Boundaries

    func testACommitThatChangesNothingRecordsNoEntry() {
        let announcer = RecordingAnnouncer()
        let session = makeSession(announcer: announcer)
        session.beginEdit()
        session.endEdit()
        XCTAssertTrue(session.undoHistory.isEmpty)
        XCTAssertFalse(session.canUndo)
        XCTAssertNil(session.lastCommittedTransaction)
        XCTAssertTrue(announcer.texts.isEmpty)
    }

    func testAnOpenTransactionClosesAtTheNextBoundary() {
        let session = makeSession()
        // Drag-bar shape: commit at touch-down, ticks, no explicit end.
        session.beginEdit(description: "Exposure")
        session.model.exposure = 0.3
        session.model.exposure = 0.6
        XCTAssertTrue(session.canUndo)  // the open transaction already moved the model
        XCTAssertTrue(session.undoHistory.isEmpty)  // …but is not recorded yet
        session.beginEdit(description: "Contrast")  // next gesture closes it
        XCTAssertEqual(session.undoHistory.count, 1)
        XCTAssertEqual(session.undoHistory[0].after.exposure, 0.6)
        session.model.contrast = 20
        session.undo()  // undo closes the contrast transaction first, then pops it
        XCTAssertEqual(session.model.contrast, 0)
        XCTAssertEqual(session.model.exposure, 0.6)
        session.undo()
        XCTAssertEqual(session.model.exposure, 0)
    }

    func testPreviewTicksNeverEnterHistoryUntilCommitted() {
        let session = makeSession()
        // No transaction open: ticks are previews, nothing to undo.
        session.model.exposure = 0.2
        session.model.exposure = 0.4
        XCTAssertFalse(session.canUndo)
        XCTAssertTrue(session.undoHistory.isEmpty)
    }

    func testCancelEditDropsTheOpenTransaction() {
        let session = makeSession()
        session.beginEdit()
        session.model.exposure = 1
        session.cancelEdit()
        XCTAssertFalse(session.canUndo)
        XCTAssertEqual(session.model.exposure, 1)  // the preview value stays, as on web
    }

    func testTransactionIDsAreMonotonic() {
        let session = makeSession()
        for i in 1...3 {
            session.beginEdit()
            session.model.exposure = Double(i)
            session.endEdit()
        }
        XCTAssertEqual(session.undoHistory.map(\.id), [1, 2, 3])
    }

    // MARK: - Accessibility

    func testCommittedUndoneAndRedoneChangesAreAnnounced() {
        let announcer = RecordingAnnouncer()
        let session = makeSession(announcer: announcer)
        let state = EditorState(session: session)
        state.arm(tool: .contrast)
        state.commit()
        state.setArmedDisplayValue(30)
        state.endGesture()
        state.undo()
        state.redo()
        XCTAssertEqual(announcer.texts, ["Contrast", "Undo Contrast", "Redo Contrast"])
    }

    // MARK: - Sidecar round-trip (real .xmp, no mocks)

    func testReloadedSemanticStateMatchesTheCommittedTransaction() async throws {
        let (session, raw) = try makeFileBackedSession()
        session.beginEdit(description: "Exposure")
        session.model.exposure = 1.25
        session.model.contrast = -15
        session.model.brightness = 8
        session.model.crop = Crop(top: 0.05, left: 0.1, bottom: 0.95, right: 0.9, angle: 1.5)
        session.endEdit()
        let tx = try XCTUnwrap(session.lastCommittedTransaction)
        // The store is an actor; let the hop from `endEdit`'s update land
        // before flushing (same convention as EditSessionPhotoKitSidecarTests).
        for _ in 0..<5 { await Task.yield() }
        await session.flushPendingSidecarWrite()

        let xmp = raw.deletingPathExtension().appendingPathExtension("xmp")
        XCTAssertTrue(FileManager.default.fileExists(atPath: xmp.path))

        let reopened = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
        await reopened.loadSidecar()
        XCTAssertEqual(
            SidecarDiff.between(tx.after, reopened.model), [],
            "reloaded sidecar state differs from the committed transaction")
        XCTAssertEqual(reopened.model.exposure, 1.25)
        XCTAssertEqual(reopened.model.crop.angle, 1.5, accuracy: 1e-6)
    }

    // MARK: - Stale render race

    /// A render carrying a generation older than the latest transaction
    /// must never publish. `renderActor.scheduleRender` bumps the generation
    /// on every model change, and `decodeAndRender` re-reads it before
    /// writing `renderedPreview`.
    func testAStaleRenderCannotReplaceNewerTransactionState() async throws {
        let (session, _) = try makeFileBackedSession()
        // A render for the pre-edit model is "in flight" holding gen g0.
        let g0 = await session.renderActor.scheduleRender(phase: .fast) { _ in }

        session.beginEdit(description: "Exposure")
        session.model.exposure = 2
        session.endEdit()  // → didSet scheduled a newer render, gen > g0

        // Supersede that live render with an idle generation so the only
        // publish attempts below are the ones this test makes.
        let live = await session.renderActor.scheduleRender(phase: .fast) { _ in }
        XCTAssertGreaterThan(live, g0)
        // Whatever the superseded live render may already have published is
        // the CORRECT state; clear it so the only way `renderedPreview`
        // becomes non-nil below is a publish from one of the two calls.
        await Task.yield()
        session.renderedPreview = nil

        await session.decodeAndRender(targetSize: nil, phase: .fast, gen: g0)
        XCTAssertNil(session.renderedPreview, "a stale render published over the newer transaction")

        await session.decodeAndRender(targetSize: nil, phase: .fast, gen: live)
        XCTAssertNotNil(session.renderedPreview, "the live render must publish")
        XCTAssertNil(session.renderError)
    }
}
