// EditHistoryEvent.swift — what just happened to the edit history (#5122).
//
// The editor confirms an Undo, a Redo and a one-tap edit with a haptic. All
// three are visible as a change in the session's transaction ring, so one
// observer covers every route to them: the header buttons, the menu, the
// keyboard. `EditHistoryMark` is the ring's observable summary and
// `EditHistoryEvent.between` names the step from one mark to the next.

import Foundation

/// The observable summary of a session's transaction ring.
public struct EditHistoryMark: Equatable, Sendable {
  /// Recorded undo entries.
  public var depth: Int
  /// The highest transaction id on either stack; `0` when both are empty.
  public var newestID: UInt64
  /// The kind of the transaction last committed, undone or redone.
  public var lastKind: EditTransaction.Kind?
  /// False until the session holds the photo's own edits. Loading them,
  /// or adopting another session's history, is not a step in it.
  public var isLoaded: Bool

  public init(depth: Int, newestID: UInt64, lastKind: EditTransaction.Kind?, isLoaded: Bool) {
    self.depth = depth
    self.newestID = newestID
    self.lastKind = lastKind
    self.isLoaded = isLoaded
  }
}

public enum EditHistoryEvent: Equatable, Sendable {
  case commit(EditTransaction.Kind)
  case undo
  case redo

  /// The step that took the ring from `old` to `new`, or `nil` when it was
  /// not a single commit, undo or redo (a load, a history swap).
  public static func between(_ old: EditHistoryMark, _ new: EditHistoryMark) -> EditHistoryEvent? {
    guard old.isLoaded, new.isLoaded else { return nil }
    let grown = new.depth - old.depth
    // Ids only grow, and only a commit brings a new one: an undo or redo
    // moves an entry between the stacks. A commit adds one entry, or none
    // once the ring is full and its oldest entry drops off.
    if new.newestID > old.newestID {
      return grown == 0 || grown == 1 ? new.lastKind.map(EditHistoryEvent.commit) : nil
    }
    guard new.newestID == old.newestID else { return nil }
    switch grown {
    case -1: return .undo
    case 1: return .redo
    default: return nil
    }
  }
}

extension EditTransaction.Kind {
  /// True for an edit that lands whole in one tap. The others are made by
  /// a gesture, which gives its own feedback while it runs.
  public var landsAtOnce: Bool {
    switch self {
    case .auto, .paste, .preset, .reset, .variant: return true
    case .adjustment, .crop, .mask, .repair: return false
    }
  }
}

extension EditSession {
  /// The transaction ring itself is not observed. An undo or redo replaces
  /// `model` and a commit replaces `lastCommittedTransaction`, so an
  /// observer of the mark is registered on both and hears every step.
  public var editHistoryMark: EditHistoryMark {
    access(keyPath: \.model)
    return EditHistoryMark(
      depth: transactions.undoStack.count,
      newestID: max(
        transactions.undoStack.lazy.map(\.id).max() ?? 0,
        transactions.redoStack.lazy.map(\.id).max() ?? 0),
      lastKind: lastCommittedTransaction?.kind, isLoaded: hasLoadedSidecar)
  }
}
