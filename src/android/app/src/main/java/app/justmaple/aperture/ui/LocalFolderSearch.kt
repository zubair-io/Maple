package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.MapleViewModel

/** Search without a server: names in the open folder. Not drawn while the saved sources are still being read. */
@Composable
internal fun LocalFolderSearch(
    query: String,
    onQuery: (String) -> Unit,
    model: MapleViewModel,
    state: MapleState,
    folderPicker: () -> Unit,
) {
    if (state.sourcesPending) return
    OutlinedTextField(
        query,
        onQuery,
        Modifier.fillMaxWidth().padding(16.dp),
        placeholder = { Text("Search photos in this folder") },
        singleLine = true,
        leadingIcon = { Icon(Icons.Outlined.Search, null) },
    )
    BrowseGrid(
        model,
        state,
        state.photos.filter { it.name.contains(query, ignoreCase = true) },
        emptyList(),
        folderPicker = folderPicker,
    )
}
