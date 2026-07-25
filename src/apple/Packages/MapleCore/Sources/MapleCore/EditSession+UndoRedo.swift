// EditSession+UndoRedo.swift — the editor's bounded undo/redo ring.
//
// Split out of `EditSession.swift` for the file-size budget (#1153). The
// two stacks stay stored on the class (Swift can't put stored properties
// in an extension); everything that operates on them lives here.
//
// Mirrors the web `EditorStateService` ring: push-on-gesture-start, cap at
// `undoStackCap` with a FIFO drop off the bottom, and a symmetric cap on
// the redo side so a long undo run can't grow it without bound.

import Foundation

extension EditSession {
    /// Ring-buffer cap on the undo/redo stacks. S5 Editor (#625) bounds
    /// the editor's undo history to 32 entries per spec §4; older entries
    /// roll off the bottom (FIFO drop on push). The same cap is honored
    /// on `redo()` to keep the two stacks symmetric.
    public static let undoStackCap: Int = 32

    public var canUndo: Bool { !undoStack.isEmpty }
    public var canRedo: Bool { !redoStack.isEmpty }

    /// Push the current model to the undo stack before a user gesture.
    /// Trims to `undoStackCap` (FIFO) so the editor's history stays bounded.
    public func beginEdit() {
        undoStack.append(model)
        if undoStack.count > Self.undoStackCap {
            undoStack.removeFirst(undoStack.count - Self.undoStackCap)
        }
        redoStack.removeAll()
    }

    public func undo() {
        guard let prev = undoStack.popLast() else { return }
        redoStack.append(model)
        if redoStack.count > Self.undoStackCap {
            redoStack.removeFirst(redoStack.count - Self.undoStackCap)
        }
        model = prev
    }

    public func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(model)
        if undoStack.count > Self.undoStackCap {
            undoStack.removeFirst(undoStack.count - Self.undoStackCap)
        }
        model = next
    }

    public func resetToOriginal() {
        beginEdit()
        model = originalModel
    }
}
