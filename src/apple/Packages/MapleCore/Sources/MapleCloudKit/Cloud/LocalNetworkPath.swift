import Network
import os

struct LocalNetworkPathSignature: Equatable, Sendable {
  let isSatisfied: Bool
  let interfaces: [String]
  let gateways: [String]
}

struct LocalNetworkPathFilter: Sendable {
  private var last: LocalNetworkPathSignature?

  mutating func shouldReprobe(for signature: LocalNetworkPathSignature) -> Bool {
    defer { last = signature }
    guard let last else { return false }
    return signature.isSatisfied && signature != last
  }
}

enum LocalNetworkPath {
  static func changes() -> AsyncStream<Void> {
    AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
      let monitor = NWPathMonitor()
      let filter = OSAllocatedUnfairLock(initialState: LocalNetworkPathFilter())
      monitor.pathUpdateHandler = { path in
        let signature = LocalNetworkPathSignature(
          isSatisfied: path.status == .satisfied,
          interfaces: path.availableInterfaces.map(\.name).sorted(),
          gateways: path.gateways.map { "\($0)" }.sorted())
        if filter.withLock({ $0.shouldReprobe(for: signature) }) {
          continuation.yield()
        }
      }
      continuation.onTermination = { _ in monitor.cancel() }
      monitor.start(queue: DispatchQueue(label: "app.justmaple.local-network-path"))
    }
  }
}
