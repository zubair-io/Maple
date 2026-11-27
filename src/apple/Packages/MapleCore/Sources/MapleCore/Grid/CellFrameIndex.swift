import CoreGraphics

/// Frames of the grid cells in one shared coordinate space, so a single view
/// can map a mouse-down point back to the on-screen cell under it.
///
/// A cell's frame outlives its time on screen: SwiftUI can keep a cell alive
/// while it scrolls out and back in without reporting the unchanged frame
/// again. Appearances are counted rather than flagged because a replacement
/// cell with the same id can appear before the old one disappears.
public struct CellFrameIndex<ID: Hashable> {
  private struct Entry {
    var frame: CGRect?
    var sequence = 0
    var appearances = 0
  }

  private var entries: [ID: Entry] = [:]
  private var onScreen: Set<ID> = []
  private var nextSequence = 0

  public init() {}

  public mutating func record(_ frame: CGRect, for id: ID) {
    entries[id, default: Entry()].frame = frame
    entries[id, default: Entry()].sequence = nextSequence
    nextSequence += 1
  }

  public mutating func appeared(_ id: ID) {
    entries[id, default: Entry()].appearances += 1
    onScreen.insert(id)
  }

  public mutating func disappeared(_ id: ID) {
    guard let appearances = entries[id]?.appearances, appearances > 0 else { return }
    entries[id]?.appearances = appearances - 1
    if appearances == 1 { onScreen.remove(id) }
  }

  public func isOnScreen(_ id: ID) -> Bool { onScreen.contains(id) }

  /// When on-screen frames overlap, the most recently recorded one wins.
  public func cell(at point: CGPoint) -> ID? {
    var best: (id: ID, sequence: Int)?
    for id in onScreen {
      guard let entry = entries[id], entry.frame?.contains(point) == true,
        entry.sequence > best?.sequence ?? -1
      else { continue }
      best = (id, entry.sequence)
    }
    return best?.id
  }
}
