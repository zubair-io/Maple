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
// is recognised by its task state when asked, not by a completion callback.

import Foundation
import os

public final class UploadTransferMonitor: NSObject, URLSessionTaskDelegate, Sendable {
  private struct Transfer {
    let task: URLSessionTask
    var lastBytesSentAt: Date
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
      transfers = transfers.filter { Self.isInFlight($0.value.task) }
      return transfers.values.map(\.lastBytesSentAt).max().map { date.timeIntervalSince($0) }
    }
  }

  public func urlSession(_ session: URLSession, didCreateTask task: URLSessionTask) {
    guard Self.carriesBody(task) else { return }
    let createdAt = now()
    transfers.withLock {
      $0[task.taskIdentifier] = Transfer(task: task, lastBytesSentAt: createdAt)
    }
  }

  public func urlSession(
    _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64, totalBytesExpectedToSend: Int64
  ) {
    guard bytesSent > 0 else { return }
    let sentAt = now()
    transfers.withLock { $0[task.taskIdentifier] = Transfer(task: task, lastBytesSentAt: sentAt) }
  }

  private static func carriesBody(_ task: URLSessionTask) -> Bool {
    guard let request = task.originalRequest else { return false }
    return request.httpBody?.isEmpty == false || request.httpBodyStream != nil
  }

  private static func isInFlight(_ task: URLSessionTask) -> Bool {
    task.state == .running || task.state == .suspended
  }
}
