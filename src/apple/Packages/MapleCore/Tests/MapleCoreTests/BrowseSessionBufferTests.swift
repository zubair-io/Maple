import Observation
import XCTest

@testable import MapleCore

@MainActor
final class BrowseSessionBufferTests: XCTestCase {
  private final class Token {}

  private final class Flag: @unchecked Sendable {
    var raised = false
  }

  private var buffer = BrowseSessionBuffer<String, Token>()

  override func setUp() {
    buffer = BrowseSessionBuffer<String, Token>()
  }

  func test_stagedSessionIsReadableByKey() {
    let token = Token()
    buffer.stage(token, for: "a")
    XCTAssertTrue(buffer.session(for: "a") === token)
    XCTAssertNil(buffer.session(for: "b"))
  }

  func test_stagingOnePhotoDoesNotNotifyAnother() {
    let fired = Flag()
    withObservationTracking {
      _ = buffer.session(for: "a")
    } onChange: {
      fired.raised = true
    }
    buffer.stage(Token(), for: "b")
    XCTAssertFalse(fired.raised)
  }

  func test_stagingAPhotoNotifiesItsReader() {
    let fired = Flag()
    withObservationTracking {
      _ = buffer.session(for: "a")
    } onChange: {
      fired.raised = true
    }
    buffer.stage(Token(), for: "a")
    XCTAssertTrue(fired.raised)
  }

  func test_takeReturnsTheStagedSessionOnce() {
    let token = Token()
    buffer.stage(token, for: "a")
    XCTAssertTrue(buffer.take("a") === token)
    XCTAssertNil(buffer.take("a"))
    XCTAssertNil(buffer.take("b"))
  }

  func test_takenSessionStaysReadable() {
    let token = Token()
    buffer.stage(token, for: "a")
    _ = buffer.take("a")
    XCTAssertTrue(buffer.session(for: "a") === token)
  }

  func test_takenSessionIsNotDrainedLater() {
    buffer.stage(Token(), for: "a")
    let other = Token()
    buffer.stage(other, for: "b")
    _ = buffer.take("a")
    let drained = buffer.drain()
    XCTAssertEqual(Set(drained.keys), ["b"])
    XCTAssertTrue(drained["b"] === other)
  }

  func test_drainReturnsEveryStagedSessionThenIsEmpty() {
    let first = Token()
    let second = Token()
    buffer.stage(first, for: "a")
    buffer.stage(second, for: "b")
    let drained = buffer.drain()
    XCTAssertEqual(Set(drained.keys), ["a", "b"])
    XCTAssertTrue(drained["a"] === first)
    XCTAssertTrue(drained["b"] === second)
    XCTAssertTrue(buffer.drain().isEmpty)
  }

  func test_drainedSessionsStayReadable() {
    let first = Token()
    buffer.stage(first, for: "a")
    _ = buffer.drain()
    XCTAssertTrue(buffer.session(for: "a") === first)
  }

  func test_drainedKeyCannotBeTaken() {
    buffer.stage(Token(), for: "a")
    _ = buffer.drain()
    XCTAssertNil(buffer.take("a"))
  }

  func test_removeForgetsTheSessionAndNotifiesItsReader() {
    buffer.stage(Token(), for: "a")
    let fired = Flag()
    withObservationTracking {
      _ = buffer.session(for: "a")
    } onChange: {
      fired.raised = true
    }
    buffer.remove("a")
    XCTAssertTrue(fired.raised)
    XCTAssertNil(buffer.session(for: "a"))
  }

  func test_removedSessionIsNotDrainedOrTaken() {
    buffer.stage(Token(), for: "a")
    buffer.remove("a")
    XCTAssertNil(buffer.take("a"))
    XCTAssertTrue(buffer.drain().isEmpty)
  }

  func test_removingOnePhotoDoesNotNotifyAnother() {
    buffer.stage(Token(), for: "a")
    buffer.stage(Token(), for: "b")
    let fired = Flag()
    withObservationTracking {
      _ = buffer.session(for: "a")
    } onChange: {
      fired.raised = true
    }
    buffer.remove("b")
    XCTAssertFalse(fired.raised)
  }

  func test_removeAllKeepingKeepsOnlyTheGivenKeys() {
    let kept = Token()
    buffer.stage(kept, for: "a")
    buffer.stage(Token(), for: "b")
    buffer.stage(Token(), for: "c")
    _ = buffer.take("a")
    buffer.removeAll(keeping: ["a", "c"])
    XCTAssertTrue(buffer.session(for: "a") === kept)
    XCTAssertNil(buffer.session(for: "b"))
    XCTAssertNotNil(buffer.session(for: "c"))
    XCTAssertEqual(Set(buffer.drain().keys), ["c"])
  }

  func test_removeAllKeepingNothingEmptiesTheBuffer() {
    buffer.stage(Token(), for: "a")
    buffer.stage(Token(), for: "b")
    buffer.removeAll(keeping: [])
    XCTAssertNil(buffer.session(for: "a"))
    XCTAssertNil(buffer.session(for: "b"))
    XCTAssertTrue(buffer.drain().isEmpty)
  }

  func test_restagingReplacesTheSession() {
    buffer.stage(Token(), for: "a")
    let second = Token()
    buffer.stage(second, for: "a")
    XCTAssertTrue(buffer.session(for: "a") === second)
  }
}
