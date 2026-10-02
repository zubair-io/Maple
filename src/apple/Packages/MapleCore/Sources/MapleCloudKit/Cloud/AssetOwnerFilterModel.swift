import Foundation
import Observation

/// Owner choices shared by Search and Timeline. Facets retain the current
/// library, folder and other filters while omitting the selected owner.
@MainActor
@Observable
public final class AssetOwnerFilterModel {
  public struct Option: Equatable, Identifiable, Sendable {
    public let id: String
    public let label: String
  }

  public let currentUserID: String?
  public private(set) var owners: [AssetOwnerFacet] = []
  public private(set) var isLoading = false
  public private(set) var loadError: Error?
  private let searchClient: CloudSearchClient
  private var generation = 0
  private var scope: SearchParams?
  private var knownLabels: [String: String] = [:]

  public init(searchClient: CloudSearchClient, currentUserID: String? = nil) {
    self.searchClient = searchClient
    self.currentUserID = currentUserID.flatMap { $0.isEmpty ? nil : $0 }
  }

  public static func scope(for params: SearchParams) -> SearchParams {
    var scoped = params
    scoped.ownerID = nil
    return scoped
  }

  public func label(for ownerID: String) -> String {
    ownerID == currentUserID ? "Only my uploads" : knownLabels[ownerID] ?? ownerID
  }

  public func options(selectedID: String?) -> [Option] {
    let all = [Option(id: "", label: "All owners")]
    let mine = currentUserID.map { [Option(id: $0, label: "Only my uploads")] } ?? []
    let members = owners.filter { $0.id != currentUserID }
      .map { Option(id: $0.id, label: label(for: $0.id)) }
    let choices = all + mine + members
    guard let selectedID, !selectedID.isEmpty,
      !choices.contains(where: { $0.id == selectedID })
    else { return choices }
    return choices + [Option(id: selectedID, label: label(for: selectedID))]
  }

  public func load(_ params: SearchParams) async {
    let requested = Self.scope(for: params)
    generation &+= 1
    let g = generation
    if scope != requested { owners = [] }
    scope = requested
    isLoading = true
    loadError = nil
    defer { if g == generation { isLoading = false } }
    do {
      let facets = try await searchClient.facets(requested)
      guard g == generation, !Task.isCancelled else { return }
      owners = facets.owners
      for owner in owners {
        let email = owner.email.trimmingCharacters(in: .whitespacesAndNewlines)
        knownLabels[owner.id] = email.isEmpty ? owner.id : email
      }
    } catch {
      guard g == generation, !(error is CancellationError),
        (error as? URLError)?.code != .cancelled
      else { return }
      loadError = error
    }
  }
}
