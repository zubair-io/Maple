package app.justmaple.aperture.cloud

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.justmaple.aperture.data.Folder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal class CloudTimelineViewModel(cloud: CloudLibrary) : ViewModel() {
    val timeline = CloudTimelineModel(
        viewModelScope,
        userId = { server -> cloud.credentials.servers().find { it.id == server }?.userId },
        fold = { server -> withContext(Dispatchers.IO) { cloud.stackPolicy.config(server).fold } },
        fetch = { server, path -> withContext(Dispatchers.IO) { cloud.http.request(server, path) } },
    )
    private var connectionsVersion: Int? = null

    fun sync(servers: List<Folder>, version: Int, active: Boolean) {
        val selected = timeline.state.value.server
        val available = servers.find { it.uri == selected?.uri }
        when {
            selected != null && available == null -> timeline.selectServer(if (active) servers.firstOrNull() else null)
            available != null && connectionsVersion != null && connectionsVersion != version -> timeline.signedIn(available)
            selected == null && active -> timeline.selectServer(servers.firstOrNull())
        }
        connectionsVersion = version
    }
}
