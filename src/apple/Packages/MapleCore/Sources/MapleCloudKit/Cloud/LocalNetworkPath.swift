import Network
import os

// Interface names and gateway addresses cannot tell two networks apart (both
// can be en0 behind 192.168.1.1), so every connected update after the first
// may be a move to another network.
struct LocalNetworkPathFilter: Sendable {
  private var hasSeenFirstUpdate = false

  mutating func shouldReprobe(isSatisfied: Bool) -> Bool {
    defer { hasSeenFirstUpdate = true }
    return hasSeenFirstUpdate && isSatisfied
  }
}

enum LocalNetworkPath {
  static func changes() -> AsyncStream<Void> {
    AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
      let monitor = NWPathMonitor()
      let filter = OSAllocatedUnfairLock(initialState: LocalNetworkPathFilter())
      monitor.pathUpdateHandler = { path in
        let isSatisfied = path.status == .satisfied
        if filter.withLock({ $0.shouldReprobe(isSatisfied: isSatisfied) }) {
          continuation.yield()
        }
      }
      continuation.onTermination = { _ in monitor.cancel() }
      monitor.start(queue: DispatchQueue(label: "app.justmaple.local-network-path"))
    }
  }
}
