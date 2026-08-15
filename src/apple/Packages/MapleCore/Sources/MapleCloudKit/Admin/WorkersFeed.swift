// WorkersFeed.swift — decides which workers snapshot the table displays.
//
// Two sources race on every open: a one-shot `GET /api/workers/status`
// (always counted) and the `/api/events` push stream, whose first frames are
// cheap registry-only snapshots with `counted: false` — zeroed counts and a
// null config.
//
// Applying an uncounted frame over real numbers flashes "0 pending / 0 dead"
// across the table on every reconnect, which reads as the queue having
// drained. This type is the rule that prevents it, kept pure so it can be
// tested without a socket.
//
// Observed against a live server (2026-08-15): the first frame arrives with
// `counted: false` carrying *14* stages, then counted frames follow carrying
// 15. So an uncounted snapshot differs in stage membership, not only in its
// numbers — which is why a counted frame replaces the payload wholesale
// rather than merging into it.

import Foundation

public struct WorkersFeed: Sendable, Equatable {
  /// What the table should render. Nil until anything arrives.
  public private(set) var payload: WorkersStatusPayload?
  /// Whether anything counted has been displayed yet.
  ///
  /// Once true it stays true, and its only job is to make `applyFallback`
  /// decline — a slow HTTP response must not rewind the table to startup
  /// values after the socket has delivered fresher ones. Uncounted frames
  /// are gated separately, on `payload` being nil, not on this flag.
  public private(set) var hasCountedData: Bool

  public init() {
    payload = nil
    hasCountedData = false
  }

  /// Apply the one-shot HTTP snapshot.
  ///
  /// Ignored once a counted WS frame has landed: the socket is fresher, and
  /// a slow HTTP response arriving late would otherwise rewind the table to
  /// startup values.
  @discardableResult
  public mutating func applyFallback(_ snapshot: WorkersStatusPayload) -> Bool {
    guard !hasCountedData else { return false }
    payload = snapshot
    hasCountedData = true
    return true
  }

  /// Apply a snapshot the caller knows is newer than anything displayed —
  /// specifically the re-read that follows a pause/resume.
  ///
  /// Distinct from `applyFallback`, which declines once counted data
  /// exists. Here the request was issued *after* the mutation, so it is
  /// authoritative by construction; deferring to the previous counted frame
  /// would leave the row showing the pre-action state for up to a tick.
  public mutating func applyAuthoritative(_ snapshot: WorkersStatusPayload) {
    payload = snapshot
    hasCountedData = true
  }

  /// Apply a push frame.
  ///
  /// A counted frame always wins. An uncounted one is accepted only when
  /// nothing is displayed yet — that first cheap snapshot is what lets the
  /// stage names and run states appear immediately instead of waiting up to
  /// two seconds for the first counted tick.
  @discardableResult
  public mutating func apply(_ frame: WorkersStatusFrame) -> Bool {
    if frame.counted {
      payload = frame.status
      hasCountedData = true
      return true
    }
    guard payload == nil else { return false }
    payload = frame.status
    return true
  }
}
