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
      try Task.checkCancellation()
      // Activate only a session whose saved edits are in memory (#4710).
      guard session.hasLoadedSidecar else {
        throw AgentError(
          code: "sidecar_unavailable",
          message:
            "Couldn't read the saved edits for \(asset.displayName) (\(session.sidecarError?.localizedDescription ?? "read failed")).")
      }
      AgentEditService.shared.activate(session)
      return session
    }
    AgentEditService.shared.browseDelegate = agentBrowseAdapter
  }
}
