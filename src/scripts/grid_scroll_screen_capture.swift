// grid_scroll_screen_capture.swift — an independent record of what a window
// actually showed, for cross-checking the app's own dropped-frame counter
// (#6048). Used by measure_grid_scroll.sh --screen-check.
//
// usage: grid_scroll_screen_capture <bundle id> <longest seconds> <output file>
//
// Waits for the app's main window, then asks the system's screen-capture
// stream for that window alone until the window goes away. The stream
// delivers one sample per display refresh on which the window's picture
// changed, stamped with the refresh time on the clock the app's report uses.
//
// A changed picture is not a scroll step: a thumbnail arriving changes it
// too. So each sample is reduced to a profile of its rows (the summed green
// channel across the middle of each row), from which the script works out
// whether the grid moved since the previous sample.
//
// Output, one line each: `start <seconds>`, then `<seconds> <row profile>`
// per changed refresh, then `stop <seconds>`. Needs Screen Recording
// permission for the terminal that runs it.

import AppKit
import CoreMedia
import ScreenCaptureKit

func now() -> Double { CACurrentMediaTime() }

final class ChangedFrames: NSObject, SCStreamOutput, SCStreamDelegate {
  private let lock = NSLock()
  private var samples: [String] = []
  private var stopped: Double?
  private let secondsPerTick: Double = {
    var timebase = mach_timebase_info_data_t()
    mach_timebase_info(&timebase)
    return Double(timebase.numer) / Double(timebase.denom) / 1e9
  }()

  func stream(
    _ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType
  ) {
    guard type == .screen,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false)
        as? [[SCStreamFrameInfo: Any]],
      let info = attachments.first,
      info[.status] as? Int == SCFrameStatus.complete.rawValue,
      let displayTime = info[.displayTime] as? UInt64
    else { return }
    guard let profile = rowProfile(of: buffer) else { return }
    let line = "\(Double(displayTime) * secondsPerTick) \(profile)"
    lock.withLock { samples.append(line) }
  }

  private func rowProfile(of buffer: CMSampleBuffer) -> String? {
    guard let pixels = CMSampleBufferGetImageBuffer(buffer) else { return nil }
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pixels)?.assumingMemoryBound(to: UInt8.self)
    else { return nil }
    let width = CVPixelBufferGetWidth(pixels)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixels)
    let columns = stride(from: width * 3 / 10, to: width * 7 / 10, by: 2)
    return (0..<CVPixelBufferGetHeight(pixels)).map { row in
      String(columns.reduce(0) { $0 + Int(base[row * bytesPerRow + $1 * 4 + 1]) })
    }.joined(separator: ",")
  }

  /// The window closing ends the stream; that is the normal way out.
  func stream(_ stream: SCStream, didStopWithError error: Error) { stop() }

  func stop() {
    lock.withLock { stopped = stopped ?? now() }
  }

  var hasStopped: Bool { lock.withLock { stopped != nil } }

  func lines(startedAt start: Double) -> String {
    lock.withLock {
      (["start \(start)"] + samples + ["stop \(stopped ?? now())"]).joined(separator: "\n")
    }
  }
}

func mainWindow(of bundleID: String) async throws -> SCWindow? {
  for _ in 0..<600 {
    let content = try await SCShareableContent.excludingDesktopWindows(
      false, onScreenWindowsOnly: true)
    let window = content.windows
      .filter { $0.owningApplication?.bundleIdentifier == bundleID && $0.frame.width > 800 }
      .max { $0.frame.width < $1.frame.width }
    if let window { return window }
    try await Task.sleep(for: .milliseconds(50))
  }
  return nil
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}

guard CommandLine.arguments.count == 4, let longest = Double(CommandLine.arguments[2]) else {
  FileHandle.standardError.write(
    Data("usage: grid_scroll_screen_capture <bundle id> <longest seconds> <output file>\n".utf8))
  exit(64)
}
// ScreenCaptureKit's window list needs a window-server connection.
_ = NSApplication.shared
let frames = ChangedFrames()
Task {
  do {
    guard let window = try await mainWindow(of: CommandLine.arguments[1]) else {
      fail("the app's window did not appear within 30 seconds")
    }
    let configuration = SCStreamConfiguration()
    configuration.width = 640
    configuration.height = 720
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 240)
    configuration.showsCursor = false
    let stream = SCStream(
      filter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration,
      delegate: frames)
    try stream.addStreamOutput(
      frames, type: .screen, sampleHandlerQueue: DispatchQueue(label: "changed-frames"))
    try await stream.startCapture()
    let started = now()
    while !frames.hasStopped, now() - started < longest {
      try await Task.sleep(for: .milliseconds(50))
    }
    if !frames.hasStopped {
      try? await stream.stopCapture()
      frames.stop()
    }
    try frames.lines(startedAt: started).write(
      toFile: CommandLine.arguments[3], atomically: true, encoding: .utf8)
    exit(0)
  } catch {
    fail("screen capture failed: \(error)")
  }
}
dispatchMain()
