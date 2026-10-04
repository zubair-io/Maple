import MapleCore
import SwiftUI

@MainActor
extension AppShell {
  func configureAgentBrowseAdapter() {
    agentBrowseAdapter.browseVM = browseVM
    agentBrowseAdapter.getSessions = { sessions }
    agentBrowseAdapter.ensureSessionHandler = { asset in
      ensureSession(for: asset)
      if let session = sessions[asset.id] {
        return session
      }
      assertionFailure("ensureSession did not populate sessions[\(asset.id)]")
      let fallback = EditSession(asset: asset)
      sessions[asset.id] = fallback
      return fallback
    }
    agentBrowseAdapter.openPhotoHandler = { asset in
      ensureSession(for: asset)
      openEditor(for: asset)
      mode = .editing
      guard let session = sessions[asset.id] else {
        throw AgentError(
          code: "session_unavailable",
          message: "Failed to open or resolve edit session for \(asset.displayName).")
      }
      AgentEditService.shared.activate(session)
      return session
    }
    AgentEditService.shared.browseDelegate = agentBrowseAdapter
  }
}
