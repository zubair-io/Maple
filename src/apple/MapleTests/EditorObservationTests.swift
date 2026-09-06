import MapleCore
import Observation
import SwiftUI
import XCTest

@testable import Maple_Exposure

@MainActor
final class EditorObservationTests: XCTestCase {
  func testSliderModelWritesDoNotInvalidateEditorShell() {
    for tool in [Tool.exposure, .temp, .contrast, .toneCurve] {
      let session = EditSession.preview()
      let state = EditorState(session: session, armedGroup: tool.group, armedTool: tool)
      let view = EditorView(state: state, onDismiss: {}, onShare: {}, onInfo: {})
      let changed = ObservationFlag()
      withObservationTracking {
        _ = view.body
      } onChange: {
        changed.mark()
      }
      switch tool {
      case .exposure: session.model.exposure = 0.75
      case .temp: session.model.temperature += 500
      case .contrast: session.model.contrast = 10
      default: session.model.toneCurveLuma = ToneCurve(points: [(x: 0.5, y: 0.6)])
      }
      XCTAssertFalse(changed.value, "\(tool) should invalidate the value/canvas leaves only")
    }
  }

  func testRenderPublicationDoesNotInvalidateEditorShell() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    let view = EditorView(state: state, onDismiss: {}, onShare: {}, onInfo: {})
    let changed = ObservationFlag()
    withObservationTracking {
      _ = view.body
    } onChange: {
      changed.mark()
    }
    session.isRendering.toggle()
    XCTAssertFalse(changed.value)
  }

  func testValueHUDStillObservesSliderChanges() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    let view = EditorValueHUD(state: state)
    let changed = ObservationFlag()
    withObservationTracking {
      _ = view.body
    } onChange: {
      changed.mark()
    }
    session.model.exposure = 0.75
    XCTAssertTrue(changed.value)
  }

  func testCanvasStillObservesRenderPublication() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    let view = EditorCanvasView(state: state)
    let changed = ObservationFlag()
    withObservationTracking {
      _ = view.canvasLeaf
    } onChange: {
      changed.mark()
    }
    session.isRendering.toggle()
    XCTAssertTrue(changed.value)
  }
}

private final class ObservationFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var changed = false

  var value: Bool { lock.withLock { changed } }
  func mark() { lock.withLock { changed = true } }
}
