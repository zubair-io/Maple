// TemporalSettingsModel.swift — load, poll and save for the Temporal section
// of the Workers page (#5826). Mirrors temporal-settings.component.ts.

import Foundation
import Observation

public enum TemporalSaveState: Equatable, Sendable {
  case idle
  case running
  case succeeded
  case failed(String)
}

@MainActor
@Observable
public final class TemporalSettingsModel {
  public typealias Fetch = @Sendable () async throws -> TemporalSettings
  public typealias Save = @Sendable (TemporalTarget) async throws -> TemporalSettings
  public typealias Sleep = @Sendable (Duration) async throws -> Void

  public private(set) var form = TemporalSettingsForm()
  public private(set) var loadError: String?
  public private(set) var saveState: TemporalSaveState = .idle

  @ObservationIgnored private let fetch: Fetch
  @ObservationIgnored private let saveTarget: Save
  @ObservationIgnored private let sleep: Sleep
  @ObservationIgnored private var watchTask: Task<Void, Never>?
  @ObservationIgnored private var isActive = false

  public init(fetch: @escaping Fetch, save: @escaping Save, sleep: @escaping Sleep) {
    self.fetch = fetch
    self.saveTarget = save
    self.sleep = sleep
  }

  public convenience init(client: WorkersAdminClient) {
    self.init(
      fetch: { try await client.temporal() },
      save: { try await client.saveTemporal($0) },
      sleep: { try await Task.sleep(for: $0) })
  }

  public var settings: TemporalSettings? { form.settings }

  public var address: String {
    get { form.address }
    set {
      guard newValue != form.address else { return }
      form.address = newValue
      draftEdited()
    }
  }

  public var namespace: String {
    get { form.namespace }
    set {
      guard newValue != form.namespace else { return }
      form.namespace = newValue
      draftEdited()
    }
  }

  public var canSave: Bool { form.target != nil && saveState != .running }

  public func start() {
    isActive = true
    restartWatch()
  }

  public func stop() {
    isActive = false
    watchTask?.cancel()
    watchTask = nil
  }

  public func retry() {
    loadError = nil
    restartWatch()
  }

  public func save() async {
    guard let target = form.target, saveState != .running else { return }
    watchTask?.cancel()
    let token = form.beginSave()
    saveState = .running
    do {
      form.adopt(try await saveTarget(target), token: token)
      saveState = form.target == target ? .succeeded : .idle
    } catch {
      saveState = .failed(error.localizedDescription)
    }
    restartWatch()
  }

  private func draftEdited() {
    if saveState != .running { saveState = .idle }
  }

  private func restartWatch() {
    watchTask?.cancel()
    watchTask = nil
    guard isActive else { return }
    watchTask = Task { [weak self] in await self?.watch() }
  }

  private func watch() async {
    if form.settings == nil {
      let token = form.generation
      do {
        let first = try await fetch()
        guard !Task.isCancelled else { return }
        form.adopt(first, token: token)
      } catch {
        if !Task.isCancelled { loadError = error.localizedDescription }
        return
      }
    }
    while let settings = form.settings {
      do { try await sleep(settings.nextPollDelay) } catch { return }
      guard !Task.isCancelled else { return }
      let token = form.generation
      let next = try? await fetch()
      // A save cancels this loop, but a read already in flight still
      // returns; landing it would show the old target's state.
      guard !Task.isCancelled else { return }
      if let next { form.adopt(next, token: token) }
    }
  }
}
