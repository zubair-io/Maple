// Sources/MapleBackup/UploadTransferMonitor.swift
//
// Watches the backup URLSession's request bodies leave the device, so "the
// backup is still sending" can be told apart from "the backup is stuck"
// while a single 4 MiB chunk takes a minute on a slow link (#5457). The
// chunk-level `onProgress` of `UploadClient` only fires once a chunk is
// accepted; this fires as URLSession reports body bytes written, which it
// does roughly every 1 MiB.
//
// Installed as the session delegate. Async `URLSession.data(for:)` never
// calls a session delegate's `didCompleteWithError`, so a finished request
// is recognised by its task state instead. Finished entries are dropped on
// every delegate callback as well as when asked, and tasks are held weakly,
// so the table stays bounded by the requests actually in flight even when
// nothing ever asks (macOS, or an iOS background backup).

import Foundation
import os

public final class UploadTransferMonitor: NSObject, URLSessionTaskDelegate, Sendable {
  private struct Transfer {
    weak var task: URLSessionTask?
    let lastBytesSentAt: Date
  }

  private let transfers = OSAllocatedUnfairLock<[Int: Transfer]>(initialState: [:])
  private let now: @Sendable () -> Date

  public init(now: @escaping @Sendable () -> Date = Date.init) {
    self.now = now
  }

  /// Seconds since a request body still being sent last moved bytes, or nil
  /// when no request with a body is in flight. A request counts from the
  /// moment it is created, so its first report isn't mistaken for a stall.
  public func secondsSinceBytesSent(at date: Date) -> TimeInterval? {
    transfers.withLock { transfers in
      transfers = Self.inFlight(transfers)
      return transfers.values.map(\.lastBytesSentAt).max().map { date.timeIntervalSince($0) }
    }
  }

  var trackedTransferCount: Int {
    transfers.withLock { $0.count }
  }

  public func urlSession(_ session: URLSession, didCreateTask task: URLSessionTask) {
    guard Self.carriesBody(task) else { return }
    let createdAt = now()
    record(task, at: createdAt)
  }

  public func urlSession(
    _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64, totalBytesExpectedToSend: Int64
  ) {
    guard bytesSent > 0 else { return }
    let sentAt = now()
    record(task, at: sentAt)
  }

  private func record(_ task: URLSessionTask, at date: Date) {
    transfers.withLock { transfers in
      transfers = Self.inFlight(transfers)
      transfers[task.taskIdentifier] = Transfer(task: task, lastBytesSentAt: date)
    }
  }

  private static func inFlight(_ transfers: [Int: Transfer]) -> [Int: Transfer] {
    transfers.filter { $0.value.task.map(isInFlight) ?? false }
  }

  private static func carriesBody(_ task: URLSessionTask) -> Bool {
    guard let request = task.originalRequest else { return false }
    return request.httpBody?.isEmpty == false || request.httpBodyStream != nil
  }

  private static func isInFlight(_ task: URLSessionTask) -> Bool {
    task.state == .running || task.state == .suspended
  }
}
