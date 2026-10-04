import MapleAgentWire
import MapleCore
import SwiftUI

@MainActor
extension AppShell {
  func configureAgentBrowseAdapter() {
    agentBrowseAdapter.browseVM = browseVM
    agentBrowseAdapter.getSessions = { sessions }
    agentBrowseAdapter.ensureSessionHandler = { asset in
      browseSession(for: asset)
    }
    agentBrowseAdapter.openPhotoHandler = { asset in
      openEditor(for: asset)
      mode = .editing
      guard let session = sessions[asset.id] else {
        throw AgentError(
          code: "session_unavailable",
          message: "Failed to open or resolve edit session for \(asset.displayName).")
      }
      await session.loadSidecar()
      AgentEditService.shared.activate(session)
      return session
    }
    AgentEditService.shared.browseDelegate = agentBrowseAdapter
  }
}
