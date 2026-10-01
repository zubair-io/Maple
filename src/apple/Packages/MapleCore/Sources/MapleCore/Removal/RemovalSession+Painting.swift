import Foundation

extension RemovalSession {
  public func paint(_ points: [[Double]], cropInputSize: [UInt32]) async {
    guard phase == .ready, mode != .people, let context, !points.isEmpty else { return }
    let token = revision &+ 1
    revision = token
    let brushRadius = radius
    let subtracting = subtract
    phase = .selecting
    message = ""
    do {
      let mapped = try await engine.map(points, context: context, cropInputSize: cropInputSize)
      guard current(token) else { return }
      // An unmapped surround/horizon breaks a stroke. Never clamp it onto an
      // edge or join two disconnected source regions with accidental paint.
      var batches: [[[Double]]] = [[]]
      for point in mapped {
        if let point {
          batches[batches.count - 1].append(point)
        } else if !batches[batches.count - 1].isEmpty {
          batches.append([])
        }
      }
      let next = batches.filter { !$0.isEmpty }.map {
        RemovalStroke(points: $0, radius: brushRadius, subtract: subtracting)
      }
      let proposed = strokes + next
      let mask = try await selectedMask(proposed, context: context, token: token)
      guard current(token) else { return }
      selection = mask
      strokes = proposed
      if !next.isEmpty {
        gestureSizes.append(next.count)
        redoGestures = []
      }
      phase = .ready
    } catch { fail(error, token: token) }
  }

  public func undoSelection() async {
    guard canUndoSelection, let context else { return }
    let count = gestureSizes.last ?? 1
    let proposed = Array(strokes.dropLast(count))
    let undone = Array(strokes.suffix(count))
    let token = revision &+ 1
    revision = token
    phase = .selecting
    do {
      let mask = try await selectedMask(proposed, context: context, token: token)
      guard current(token) else { return }
      selection = mask
      strokes = proposed
      gestureSizes.removeLast()
      redoGestures.append(undone)
      phase = .ready
    } catch { fail(error, token: token) }
  }

  public func redoSelection() async {
    guard canRedoSelection, let context, let gesture = redoGestures.last else { return }
    let proposed = strokes + gesture
    let token = revision &+ 1
    revision = token
    phase = .selecting
    do {
      let mask = try await selectedMask(proposed, context: context, token: token)
      guard current(token) else { return }
      selection = mask
      strokes = proposed
      gestureSizes.append(gesture.count)
      redoGestures.removeLast()
      phase = .ready
    } catch { fail(error, token: token) }
  }

  private func selectedMask(
    _ strokes: [RemovalStroke], context: NativeRemovalEditorContext, token: UInt64
  ) async throws -> Data {
    let mask: Data
    if strokes.isEmpty {
      mask = Data()
    } else if mode == .paint {
      mask = try await engine.paint(strokes, context: context)
    } else {
      let run = try await engine.selectionOperation()
      guard current(token) else {
        run.cancel()
        throw CancellationError()
      }
      operation = run
      mask = try await engine.smart(strokes, context: context, operation: run)
    }
    guard current(token) else { throw CancellationError() }
    operation = nil
    return try RemovalBridge.combineMasks(mask, protection, subtract: true)
  }
}
